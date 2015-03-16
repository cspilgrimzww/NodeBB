'use strict';

var winston = require('winston'),
	fork = require('child_process').fork,
	path = require('path'),
	async = require('async'),
	_ = require('underscore'),
	os = require('os'),
	nconf = require('nconf'),
	fs = require('fs'),

	plugins = require('../plugins'),
	emitter = require('../emitter'),
	utils = require('../../public/src/utils');

module.exports = function(Meta) {

	Meta.js = {
		cache: '',
		map: '',
		hash: +new Date(),
		prepared: false,
		minFile: 'nodebb.min.js',
		scripts: {
			base: [
				'bower_components/jquery/dist/jquery.js',
				'bower_components/jquery.ui/ui/core.js',
				'bower_components/jquery.ui/ui/widget.js',
				'bower_components/jquery.ui/ui/mouse.js',
				'bower_components/jquery.ui/ui/position.js',
				'bower_components/jquery.ui/ui/draggable.js',
				'bower_components/jquery.ui/ui/droppable.js',
				'bower_components/jquery.ui/ui/resizable.js',
				'bower_components/jquery.ui/ui/sortable.js',
				'bower_components/jquery.ui/ui/autocomplete.js',
				'bower_components/jquery.ui/ui/datepicker.js',
				'bower_components/jquery.ui/ui/menu.js',
				'bower_components/jquery-timeago/jquery.timeago.js',
				'bower_components/jquery-form/jquery.form.js',
				'bower_components/visibilityjs/lib/visibility.core.js',
				'bower_components/visibilityjs/lib/visibility.timers.js',
				'bower_components/bootstrap/dist/js/bootstrap.js',
				'bower_components/bootstrap-tagsinput/dist/bootstrap-tagsinput.js',
				'bower_components/jquery-textcomplete/dist/jquery.textcomplete.js',
				'bower_components/bootbox/bootbox.js',
				'bower_components/tinycon/tinycon.js',
				'bower_components/buzz/dist/buzz.js',
				'bower_components/mousetrap/mousetrap.js',
				'./node_modules/socket.io-client/socket.io.js',

				// Anything before this line does not use Require.js (or if it does, isn't prepped in a way so that it can be require'd easily)

				'public/vendor/requirejs/require.js',
				'public/vendor/xregexp/xregexp.js',
				'public/vendor/xregexp/unicode/unicode-base.js',
				'public/vendor/autosize.js',
				'./node_modules/templates.js/lib/templates.js',
				'public/src/utils.js',
				'public/src/app.js',
				'public/src/ajaxify.js',
				'public/src/variables.js',
				'public/src/widgets.js',
				'public/src/translator.js',
				'public/src/overrides.js'
			],
			rjs: []
		}
	};

	Meta.js.loadRJS = function(callback) {
		var rjsPath = path.join(__dirname, '../../public/src');

		async.parallel({
			client: function(next) {
				utils.walk(path.join(rjsPath, 'client'), next);
			},
			modules: function(next) {
				if (global.env === 'development') {
					return next(null, []);
				}

				utils.walk(path.join(rjsPath, 'modules'), next);
			}
		}, function(err, rjsFiles) {
			if (err) {
				return callback(err);
			}
			rjsFiles = rjsFiles.client.concat(rjsFiles.modules);

			rjsFiles = rjsFiles.map(function(file) {
				return path.join('public/src', file.replace(rjsPath, ''));
			});

			Meta.js.scripts.rjs = rjsFiles;

			callback();
		});
	};

	Meta.js.prepare = function (callback) {
		async.parallel([
			async.apply(Meta.js.loadRJS),	// Require.js scripts
			async.apply(getPluginScripts),	// plugin scripts via filter:scripts.get
			function(next) {	// client scripts via "scripts" config in plugin.json
				var pluginsScripts = [],
					pluginDirectories = [],
					clientScripts = [];

				pluginsScripts = plugins.clientScripts.filter(function(path) {
					if (path.indexOf('.js') !== -1) {
						return true;
					} else {
						pluginDirectories.push(path);
						return false;
					}
				});

				// Add plugin scripts
				Meta.js.scripts.client = pluginsScripts;

				// Add plugin script directories
				async.each(pluginDirectories, function(directory, next) {
					utils.walk(directory, function(err, scripts) {
						Meta.js.scripts.client = Meta.js.scripts.client.concat(scripts);
						next(err);
					});
				}, next);
			}
		], function(err) {
			if (err) {
				return callback(err);
			}

			// Convert all scripts to paths relative to the NodeBB base directory
			var basePath = path.resolve(__dirname, '../..');
			Meta.js.scripts.all = Meta.js.scripts.base.concat(Meta.js.scripts.rjs, Meta.js.scripts.plugin, Meta.js.scripts.client).map(function(script) {
				return path.relative(basePath, script).replace(/\\/g, '/');
			});
			callback();
		});
	};

	Meta.js.minify = function(minify, callback) {
		if (nconf.get('isPrimary') === 'true') {
			var minifier = Meta.js.minifierProc = fork('minifier.js'),
				onComplete = function(err) {
					if (err) {
						winston.error('[meta/js] Minification failed: ' + err.message);
						process.exit(0);
					}

					winston.verbose('[meta/js] Minification complete');
					minifier.kill();

					if (process.send) {
						process.send({
							action: 'js-propagate',
							cache: Meta.js.cache,
							map: Meta.js.map,
							hash: Meta.js.hash
						});
					}

					Meta.js.commitToFile();

					if (typeof callback === 'function') {
						callback();
					}
				};

			minifier.on('message', function(message) {
				switch(message.type) {
				case 'end':
					Meta.js.cache = message.minified;
					onComplete();
					break;
				case 'hash':
					Meta.js.hash = message.payload;
					break;
				case 'error':
					winston.error('[meta/js] Could not compile client-side scripts! ' + message.payload.message);
					minifier.kill();
					if (typeof callback === 'function') {
						callback(new Error(message.payload.message));
					} else {
						process.exit(0);
					}
					break;
				}
			});

			Meta.js.prepare(function() {
				minifier.send({
					action: 'js',
					minify: global.env !== 'development',
					scripts: Meta.js.scripts.all
				});
			});
		} else {
			if (typeof callback === 'function') {
				callback();
			}
		}
	};

	Meta.js.killMinifier = function(callback) {
		if (Meta.js.minifierProc) {
			Meta.js.minifierProc.kill('SIGTERM');
		}
	};

	Meta.js.commitToFile = function() {
		async.parallel([
			async.apply(fs.writeFile, path.join(__dirname, '../../public/nodebb.min.js'), Meta.js.cache)
		], function (err) {
			if (!err) {
				winston.verbose('[meta/js] Client-side minfile committed to disk.');
				emitter.emit('meta:js.compiled');
			} else {
				winston.error('[meta/js] ' + err.message);
				process.exit(0);
			}
		});
	};

	Meta.js.getFromFile = function(minify, callback) {
		var scriptPath = path.join(__dirname, '../../public/nodebb.min.js'),
			mapPath = path.join(__dirname, '../../public/nodebb.min.js.map'),
			paths = [scriptPath];
		fs.exists(scriptPath, function(exists) {
			if (exists) {
				if (nconf.get('isPrimary') === 'true') {
					fs.exists(mapPath, function(exists) {
						if (exists) {
							paths.push(mapPath);
						}

						winston.verbose('[meta/js] Reading client-side scripts from file');
						async.map(paths, fs.readFile, function(err, files) {
							Meta.js.cache = files[0];
							Meta.js.map = files[1] || '';

							emitter.emit('meta:js.compiled');
							callback();
						});
					});
				} else {
					callback();
				}
			} else {
				winston.warn('[meta/js] No script file found on disk, re-minifying');
				Meta.js.minify.apply(Meta.js, arguments);
			}
		});
	};

	function getPluginScripts(callback) {
		plugins.fireHook('filter:scripts.get', [], function(err, scripts) {
			if (err) {
				callback(err, []);
			}

			var jsPaths = scripts.map(function (jsPath) {
					jsPath = path.normalize(jsPath);

					var	matches = _.map(plugins.staticDirs, function(realPath, mappedPath) {
						if (jsPath.match(mappedPath)) {
							return mappedPath;
						} else {
							return null;
						}
					}).filter(function(a) { return a; });

					if (matches.length) {
						var	relPath = jsPath.slice(('plugins/' + matches[0]).length),
							pluginId = matches[0].split(path.sep)[0];

						return plugins.staticDirs[matches[0]] + relPath;
					} else {
						winston.warn('[meta.scripts.get] Could not resolve mapped path: ' + jsPath + '. Are you sure it is defined by a plugin?');
						return null;
					}
				});

			Meta.js.scripts.plugin = jsPaths.filter(Boolean);
			callback();
		});
	}
};
/**
 * pluginSource.ts — the source of the McpBridge plugin that runs inside the game.
 *
 * This is authored as ES5 on purpose: RPG Maker MV 1.0-1.5 ships nwjs 0.12
 * (Chromium 41), so `let`, arrow functions and template literals are not safe
 * to assume. It uses only engine APIs that exist in the MV corescript.
 *
 * Map hot-reload deserves a note, because the obvious implementation is wrong.
 * Rebuilding `Spriteset_Map` by hand leaves `Game_Map` holding the old
 * `$dataMap`, and reassigning `$dataMap` mid-frame can null it out while
 * `Scene_Map` is updating. The engine already has the right seam:
 * `Game_Player._needsMapReload` makes `performTransfer` re-run `$gameMap.setup`
 * even when the destination is the current map, and `Scene_Map.create` calls
 * `DataManager.loadMapData`, which re-reads MapXXX.json from disk. So a
 * reserved transfer to the player's own position with `_needsMapReload = true`
 * is a full, engine-sanctioned reload that keeps party state and variables.
 */

export const BRIDGE_PLUGIN_NAME = 'McpBridge';

export interface BridgePluginOptions {
  /** Fallback port if the handshake file cannot be read. */
  port?: number;
  /** How often the player position frame is sent, in frames (default 30). */
  telemetryInterval?: number;
}

/** The plugin's @param block, mirrored into js/plugins.js so PluginManager sees the defaults. */
export interface BridgePluginSpec {
  description: string;
  author: string;
  help: string;
  params: { name: string; type: string; desc: string; default: string | number }[];
  body: string;
}

const HELP_TEXT = [
  'This plugin connects the running game to the MCP server so an AI agent can',
  'see what the game is doing: exceptions, scene changes, player position, and',
  'the values of switches and variables. It also accepts a fixed set of',
  'commands (reload the map, reload a database file, take a screenshot, move',
  'the player).',
  '',
  'It does nothing outside playtest. The guard at the top returns immediately',
  'when the game was not launched in test mode, so a deployed build never opens',
  'a socket and never reads the handshake file.',
  '',
  'The port and the session token are read from .mcp-bridge.json in the project',
  'root, written by the MCP server when the bridge starts. Without a valid token',
  'the server closes the connection.',
].join('\n');

/**
 * Build the full plugin spec. The header is left to pluginTools.createPlugin so
 * the @param defaults also land in js/plugins.js, which is where
 * PluginManager.parameters actually reads them from.
 */
export function buildBridgePlugin(opts: BridgePluginOptions = {}): BridgePluginSpec {
  const port = opts.port ?? 32123;
  const interval = opts.telemetryInterval ?? 30;
  return {
    description: 'Live telemetry and hot-reload bridge for the RPG Maker MV MCP server. Playtest only.',
    author: 'RPG Maker MV Ultimate (MCP)',
    help: HELP_TEXT,
    params: [
      { name: 'Fallback Port', type: 'number', desc: 'Port used when .mcp-bridge.json cannot be read.', default: port },
      { name: 'Telemetry Interval', type: 'number', desc: 'Frames between player-state frames (60 = once per second).', default: interval },
    ],
    body: `(function () {
    'use strict';

    // Playtest guard. MV 1.6.1 only checks nw.App.argv[0], but a direct launch
    // through the bundled runtime can put the project path first and "test"
    // in a later argument. Inspect every argument without weakening the guard:
    // deployed builds still have no test token and never open a socket.
    function isPlaytest() {
        if (typeof Utils === 'undefined' || !Utils.isNwjs()) return false;
        if (Utils.isOptionValid('test')) return true;
        if (typeof nw === 'undefined' || !nw.App || !nw.App.argv) return false;
        for (var i = 0; i < nw.App.argv.length; i++) {
            if (String(nw.App.argv[i]).split('&').indexOf('test') >= 0) return true;
        }
        return false;
    }
    if (!isPlaytest()) return;

    var parameters = PluginManager.parameters('${BRIDGE_PLUGIN_NAME}');
    var FALLBACK_PORT = Number(parameters['Fallback Port'] || ${port});
    var INTERVAL = Number(parameters['Telemetry Interval'] || ${interval});
    var HANDSHAKE = '.mcp-bridge.json';
    var DIAGNOSTIC_DIR = '.mcp-cache';
    var DIAGNOSTIC = 'bridge-plugin.log';
    var RETRY_MS = 3000;

    var fs = require('fs');
    var path = require('path');

    var ws = null;
    var authed = false;
    var pendingReload = null;
    var diagnosticPath = null;
    var diagnosticSeen = {};

    // Keep a small credential-free lifecycle log next to the handshake file.
    // The live socket cannot report why it failed before it has connected, so
    // without this file a bad path or WebSocket rejection is invisible.
    // Alongside the screenshots rather than loose in the project root, so the
    // bridge leaves exactly one directory behind.
    function diagnosticFile() {
        var dir = path.join(projectRoot(), DIAGNOSTIC_DIR);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* already there, or unwritable */ }
        return path.join(dir, DIAGNOSTIC);
    }

    function diagnose(message) {
        if (diagnosticSeen[message]) return;
        diagnosticSeen[message] = true;
        try {
            if (!diagnosticPath) diagnosticPath = diagnosticFile();
            fs.appendFileSync(diagnosticPath, new Date().toISOString() + ' ' + message + '\\n', 'utf8');
        } catch (e) { /* diagnostics must never interrupt the game */ }
    }

    // Modern MV's NW.js runtime exposes index.html as chrome-extension://...;
    // in that mode the process working directory is the project root. Older
    // runtimes use file:///C:/... and can be resolved from the pathname.
    function projectRoot() {
        // typeof, not a truthiness check: a bare \`process\` throws ReferenceError
        // rather than short-circuiting when the global is absent.
        if (window.location.protocol !== 'file:' && typeof process !== 'undefined' && process.cwd) {
            return path.resolve(process.cwd());
        }
        var p = decodeURIComponent(window.location.pathname);
        if (p.charAt(0) === '/' && /^\\/[A-Za-z]:/.test(p)) p = p.slice(1);
        return path.dirname(p);
    }

    function readHandshake() {
        try {
            return JSON.parse(fs.readFileSync(path.join(projectRoot(), HANDSHAKE), 'utf8'));
        } catch (e) {
            diagnose('handshake read failed: ' + String((e && e.message) || e));
            return null;
        }
    }

    function send(payload) {
        if (!ws || ws.readyState !== 1 || !authed) return;
        try { ws.send(JSON.stringify(payload)); } catch (e) { /* socket died mid-frame */ }
    }

    function connect() {
        var hs = readHandshake();
        var port = hs && hs.port ? hs.port : FALLBACK_PORT;
        var token = hs && hs.token ? hs.token : null;
        if (!token) { diagnose('waiting for bridge handshake'); setTimeout(connect, RETRY_MS); return; }

        try {
            ws = new WebSocket('ws://127.0.0.1:' + port);
        } catch (e) {
            diagnose('WebSocket construction failed: ' + String((e && e.message) || e));
            setTimeout(connect, RETRY_MS);
            return;
        }

        ws.onopen = function () {
            diagnose('socket open on port ' + port);
            authed = true; // the server closes the socket if the token is wrong
            try { ws.send(JSON.stringify({ type: 'auth', token: token })); } catch (e) { /* ignore */ }
            send({
                type: 'ready',
                engine: 'RPG Maker MV',
                mvVersion: Utils.RPGMAKER_VERSION || 'unknown',
                scene: SceneManager._scene ? SceneManager._scene.constructor.name : 'None'
            });
        };

        ws.onmessage = function (event) {
            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (!msg || !msg.action) return;
            try {
                handleCommand(msg);
            } catch (e) {
                send({ type: 'error', requestId: msg.requestId, message: String((e && e.message) || e) });
            }
        };

        ws.onclose = function (event) {
            diagnose('socket closed: code=' + String(event && event.code) + ' reason=' + String((event && event.reason) || ''));
            authed = false;
            ws = null;
            setTimeout(connect, RETRY_MS);
        };

        ws.onerror = function (event) {
            diagnose('socket error: ' + String((event && event.message) || 'unspecified WebSocket error'));
        };
    }

    function handleCommand(msg) {
        switch (msg.action) {
            case 'ping':
                send({ type: 'log', level: 'info', requestId: msg.requestId, message: 'pong' });
                break;
            case 'get_state':
                send({
                    type: 'state_dump',
                    requestId: msg.requestId,
                    switches: dumpSwitches(),
                    variables: dumpVariables()
                });
                break;
            case 'reload_map':
                reloadMap(msg.requestId);
                break;
            case 'reload_database':
                reloadDatabase(msg.requestId, msg.file, msg.globalVar);
                break;
            case 'capture_screenshot':
                captureScreenshot(msg.requestId);
                break;
            case 'teleport_player':
                teleport(msg);
                break;
            default:
                // Unknown actions are ignored on purpose: the command surface is
                // fixed on both ends, so anything else is noise or an attack.
                break;
        }
    }

    function dumpSwitches() {
        var out = {};
        if (!window.$gameSwitches) return out;
        var data = $gameSwitches._data || [];
        for (var i = 1; i < data.length; i++) if (data[i]) out[i] = true;
        return out;
    }

    function dumpVariables() {
        var out = {};
        if (!window.$gameVariables) return out;
        var data = $gameVariables._data || [];
        for (var i = 1; i < data.length; i++) {
            var v = data[i];
            if (v !== undefined && v !== null && v !== 0 && v !== '') out[i] = v;
        }
        return out;
    }

    /**
     * Reload MapXXX.json from disk without losing party state. See the module
     * comment: reserving a transfer to the current position with
     * _needsMapReload makes Scene_Map re-read the file through DataManager.
     */
    function reloadMap(requestId) {
        if (!window.$gameMap || !window.$gamePlayer) {
            send({ type: 'error', requestId: requestId, message: 'No map is loaded yet.' });
            return;
        }
        var mapId = $gameMap.mapId();
        pendingReload = { requestId: requestId, mapId: mapId };
        $gamePlayer.reserveTransfer(mapId, $gamePlayer.x, $gamePlayer.y, $gamePlayer.direction(), 2);
        $gamePlayer._needsMapReload = true;
    }

    function reloadDatabase(requestId, file, globalVar) {
        if (!file || !globalVar) {
            send({ type: 'error', requestId: requestId, message: 'reload_database needs file and globalVar.' });
            return;
        }
        DataManager.loadDataFile(globalVar, file);
        var tries = 0;
        var check = function () {
            if (window[globalVar]) {
                send({ type: 'reload_complete', requestId: requestId, target: 'database', file: file });
            } else if (++tries < 100) {
                setTimeout(check, 50);
            } else {
                send({ type: 'error', requestId: requestId, message: 'Timed out reloading ' + file });
            }
        };
        setTimeout(check, 50);
    }

    function captureScreenshot(requestId) {
        var bitmap = SceneManager.snap();
        if (!bitmap || !bitmap.canvas) {
            send({ type: 'error', requestId: requestId, message: 'Could not snapshot the scene.' });
            return;
        }
        var url = bitmap.canvas.toDataURL('image/png');
        send({
            type: 'screenshot_result',
            requestId: requestId,
            mimeType: 'image/png',
            base64: url.slice(url.indexOf(',') + 1)
        });
    }

    function teleport(msg) {
        if (!window.$gamePlayer || !window.$gameMap) {
            send({ type: 'error', requestId: msg.requestId, message: 'No player yet.' });
            return;
        }
        var mapId = msg.mapId || $gameMap.mapId();
        $gamePlayer.reserveTransfer(mapId, msg.x | 0, msg.y | 0, msg.direction || $gamePlayer.direction(), 0);
        send({ type: 'log', level: 'info', requestId: msg.requestId, message: 'Transfer reserved to map ' + mapId });
    }

    window.addEventListener('error', function (e) {
        send({
            type: 'exception',
            message: e.message,
            filename: e.filename,
            line: e.lineno,
            col: e.colno,
            stack: e.error && e.error.stack ? e.error.stack : ''
        });
    });

    var _consoleError = console.error;
    console.error = function () {
        _consoleError.apply(console, arguments);
        send({ type: 'log', level: 'error', message: Array.prototype.map.call(arguments, String).join(' ') });
    };

    var _consoleWarn = console.warn;
    console.warn = function () {
        _consoleWarn.apply(console, arguments);
        send({ type: 'log', level: 'warn', message: Array.prototype.map.call(arguments, String).join(' ') });
    };

    var _SceneManager_goto = SceneManager.goto;
    SceneManager.goto = function (sceneClass) {
        var from = this._scene ? this._scene.constructor.name : 'None';
        _SceneManager_goto.call(this, sceneClass);
        send({
            type: 'scene_change',
            from: from,
            to: sceneClass ? sceneClass.name : 'Unknown',
            mapId: window.$gameMap ? $gameMap.mapId() : undefined
        });
    };

    // A reload finishes when the reloaded map is up and running again.
    var _Scene_Map_onMapLoaded = Scene_Map.prototype.onMapLoaded;
    Scene_Map.prototype.onMapLoaded = function () {
        _Scene_Map_onMapLoaded.call(this);
        if (pendingReload) {
            var p = pendingReload;
            pendingReload = null;
            send({ type: 'reload_complete', requestId: p.requestId, target: 'map', mapId: p.mapId });
        }
    };

    var frameCounter = 0;
    var lastFrameCount = 0;
    var lastFpsAt = Date.now();
    var fps = 60;

    var _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function () {
        _Scene_Map_update.call(this);
        if (++frameCounter < INTERVAL) return;
        frameCounter = 0;

        // Derive FPS from Graphics.frameCount rather than Graphics._fpsMeter,
        // which only exists while the FPS display is switched on.
        var now = Date.now();
        var elapsed = now - lastFpsAt;
        if (elapsed > 0) {
            fps = Math.round(((Graphics.frameCount - lastFrameCount) * 1000) / elapsed);
            lastFrameCount = Graphics.frameCount;
            lastFpsAt = now;
        }

        send({
            type: 'player_state',
            mapId: $gameMap.mapId(),
            x: $gamePlayer.x,
            y: $gamePlayer.y,
            direction: $gamePlayer.direction(),
            isMoving: $gamePlayer.isMoving()
        });
        send({
            type: 'performance',
            fps: fps,
            memoryMB: (window.process && process.memoryUsage) ? Math.round(process.memoryUsage().heapUsed / 1048576) : 0
        });
    };

    // Which command an event is on, so a hung event can be pinpointed. Only map
    // events are reported; common events would flood the channel.
    var _Game_Interpreter_executeCommand = Game_Interpreter.prototype.executeCommand;
    Game_Interpreter.prototype.executeCommand = function () {
        var cmd = this.currentCommand();
        if (cmd && this._eventId > 0 && window.$gameMap) {
            send({
                type: 'interpreter_step',
                mapId: $gameMap.mapId(),
                eventId: this._eventId,
                commandIndex: this._index,
                code: cmd.code,
                indent: cmd.indent
            });
        }
        return _Game_Interpreter_executeCommand.call(this);
    };

    try {
        diagnosticPath = diagnosticFile();
        fs.writeFileSync(diagnosticPath, new Date().toISOString() + ' plugin loaded; root=' + projectRoot() + '\\n', 'utf8');
    } catch (e) { /* the bridge can still try its fallback port */ }
    connect();
})();
`,
  };
}

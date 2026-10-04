/**
 * The in-page half of the headless engine driver, installed into the game page
 * as `window.__mcp`.
 *
 * It is deliberately a plain-JS **string**, not a TypeScript function handed to
 * `page.evaluate`: Playwright serializes functions with `toString()`, and when
 * the server runs from source under tsx/esbuild, `keepNames` rewrites named
 * inner functions into `__name(...)` calls — a helper that does not exist inside
 * the page. Strings sidestep that entirely, and the Node side only ever calls
 * `__mcp.<fn>(<JSON args>)`.
 *
 * Everything here drives RPG Maker MV through its own engine APIs. Keyboard events do
 * not reach the engine headless, so input is simulated by toggling
 * `Input._currentState[button]` (see `press` in session.ts).
 */
export const ENGINE_DRIVER = String.raw`
(() => {
  if (window.__mcp) return;
  // text: message lines, each tagged with whether it was shown in battle (a
  // troop's battle event, victory/defeat messages) or on the map.
  // transfer: the last completed player transfer, cleared by the Node side
  // before a walk/startEvent so it can report where a door led.
  const log = { text: [], choices: null, transfer: null };
  const sceneName = () => (SceneManager._scene ? SceneManager._scene.constructor.name : null);
  const inBattle = () => !!(window.$gameParty && $gameParty.inBattle());
  const pushText = (text) => log.text.push({ text, battle: inBattle() });

  // Run message text through the engine's own escape conversion, as the message
  // window does when it shows it: \V[n], \N[n], \P[n] and \G expand from the
  // current game state and \\ becomes a backslash. The control codes left
  // (\C[n], \I[n], \., \| …) come back ESC-prefixed; the Node side strips them
  // (stripControlCodes in text.ts). Window_Message's prototype picks up plugin
  // extensions; if one needs a live window, fall back to the bare \ → ESC step.
  const convert = (text) => {
    const raw = String(text == null ? '' : text);
    try {
      const proto = (window.Window_Message || Window_Base).prototype;
      return String(proto.convertEscapeCharacters.call(proto, raw));
    } catch (e) {
      return raw.replace(/\\/g, '\x1b').replace(/\x1b\x1b/g, '\\');
    }
  };

  // Battle fast-forward: while Scene_Battle is on screen, run this many engine
  // frames per animation frame (1 = real time). Every battle wait — log
  // messages, animations, collapse effects, fades — is counted in frames, so the
  // battle plays out exactly as it would, just sooner, with one frame in N drawn.
  // The map stays real time, so walking and message handling are unaffected.
  let battleSpeed = 1;
  const fastBattle = () => battleSpeed > 1 && SceneManager._scene instanceof Scene_Battle;

  // Record every message line the engine is asked to show, so advanceText can
  // report what was said without OCR. Installed lazily (Game_Message exists only
  // once the engine scripts have loaded).
  const hook = () => {
    if (window.__mcpHooked || !window.Game_Message) return;
    window.__mcpHooked = true;
    const add = Game_Message.prototype.add;
    Game_Message.prototype.add = function (text) {
      pushText(convert(text));
      return add.call(this, text);
    };
    const setChoices = Game_Message.prototype.setChoices;
    Game_Message.prototype.setChoices = function (choices, def, cancel) {
      log.choices = choices.map(convert);
      return setChoices.call(this, choices, def, cancel);
    };
    const setSpeakerName = Game_Message.prototype.setSpeakerName;
    if (setSpeakerName) {
      Game_Message.prototype.setSpeakerName = function (name) {
        if (name) pushText('[' + convert(name) + ']');
        return setSpeakerName.call(this, name);
      };
    }
    if (SceneManager.determineRepeatNumber) {
      const repeat = SceneManager.determineRepeatNumber;
      SceneManager.determineRepeatNumber = function (deltaTime) {
        const n = repeat.call(this, deltaTime);
        return fastBattle() ? n * battleSpeed : n;
      };
    } else {
      // MV updateMain schedules requestAnimationFrame and advances a wall-clock
      // accumulator. Repeat only scene logic, never that outer scheduler.
      const updateScene = SceneManager.updateScene;
      SceneManager.updateScene = function () {
        const n = fastBattle() ? battleSpeed : 1;
        for (let i = 0; i < n; i++) {
          if (i && (!fastBattle() || this.isSceneChanging())) break;
          updateScene.call(this);
        }
      };
    }
    const performTransfer = Game_Player.prototype.performTransfer;
    Game_Player.prototype.performTransfer = function () {
      const was = this.isTransferring();
      const r = performTransfer.call(this);
      if (was) log.transfer = { mapId: $gameMap.mapId(), x: this.x, y: this.y };
      return r;
    };
  };

  const itemOf = (kind, id) =>
    kind === 'weapon' ? $dataWeapons[id] : kind === 'armor' ? $dataArmors[id] : $dataItems[id];

  window.__mcp = {
    sceneName,

    sceneIs(name) {
      return sceneName() === name && !SceneManager.isSceneChanging();
    },

    // Booted far enough to drive: database loaded and past Scene_Boot. (Waiting
    // for Scene_Title specifically would hang on title-skip plugins.)
    booted() {
      const s = sceneName();
      return !!(window.DataManager && DataManager.isDatabaseLoaded() && s && s !== 'Scene_Boot');
    },

    init() {
      hook();
      AudioManager.masterVolume = 0;
      // No on-screen menu/cancel buttons: nothing clicks them headless, and they
      // would sit on top of every screenshot.
      ConfigManager.touchUI = false;
      // A missing image/sound would otherwise stop the engine on its "Failed to
      // load" retry screen. Treat it as loaded-but-blank instead, so the run goes
      // on and the 404 is reported in problems (a missing sprite simply doesn't draw).
      ImageManager.throwLoadError = function () {};
      const bitmapReady = Bitmap.prototype.isReady;
      Bitmap.prototype.isReady = function () {
        return this.isError() || bitmapReady.call(this);
      };
      if (window.AudioManager) AudioManager.throwLoadError = function () {};
      return true;
    },

    // Resize the whole game canvas to the map's pixel size, so one screenshot
    // captures the full map. Must run before Scene_Map is created.
    resizeToMap(w, h) {
      Graphics.width = w;
      Graphics.height = h;
      SceneManager._screenWidth = w;
      SceneManager._screenHeight = h;
      Graphics.boxWidth = w;
      Graphics.boxHeight = h;
      return true;
    },

    // Freeze event processing so a render shows the map's resting state rather
    // than whatever an autorun cutscene has drawn over it.
    suppressEvents() {
      Game_Map.prototype.setupStartingEvent = function () { return false; };
      Game_Map.prototype.updateEvents = function () {};
      Game_Map.prototype.updateInterpreter = function () {};
      Game_Map.prototype.isEventRunning = function () { return false; };
      Game_CommonEvent.prototype.update = function () {};
      return true;
    },

    // Leaving a live Scene_Map before setupNewGame avoids nulling the tileset
    // under the spriteset ("tilesetNames of null").
    leaveMap() {
      if (window.$gameMap && $gameMap._interpreter) $gameMap._interpreter.clear();
      if (window.$gameMessage) $gameMessage.clear();
      if (sceneName() === 'Scene_Map' || sceneName() === 'Scene_Battle') SceneManager.goto(Scene_Title);
      return true;
    },

    idleOffMap() {
      const s = sceneName();
      return s !== 'Scene_Map' && s !== 'Scene_Battle' && !SceneManager.isSceneChanging();
    },

    // Start a fresh game and transfer to (mapId, x, y), applying the requested
    // starting state. Everything is optional except the destination.
    load(L) {
      hook();
      DataManager.setupNewGame();
      if (L.party) {
        $gameParty._actors = [];
        L.party.forEach((a) => $gameParty.addActor(a));
      }
      if (L.level) $gameParty.members().forEach((a) => a.changeLevel(L.level, false));
      (L.switches || []).forEach((s) => $gameSwitches.setValue(s, true));
      Object.entries(L.variables || {}).forEach(([k, v]) => $gameVariables.setValue(Number(k), v));
      (L.selfSwitches || []).forEach((s) =>
        $gameSelfSwitches.setValue([s.mapId, s.eventId, s.letter], s.value !== false),
      );
      (L.items || []).forEach((it) => {
        const item = itemOf(it.kind, it.id);
        if (!item) throw new Error('No ' + (it.kind || 'item') + ' with id ' + it.id);
        $gameParty.gainItem(item, it.count ?? 1);
      });
      (L.equip || []).forEach((e) => {
        const actor = $gameActors.actor(e.actorId);
        const item = itemOf(e.kind, e.id);
        if (!actor || !item) throw new Error('Bad equip entry ' + JSON.stringify(e));
        $gameParty.gainItem(item, 1);
        actor.changeEquip(e.slot, item);
      });
      if (L.gold) $gameParty.gainGold(L.gold);
      $gameParty.members().forEach((a) => a.recoverAll());
      if (!L.encounters) $gameSystem.disableEncounter();
      $gamePlayer.reserveTransfer(L.mapId, L.x, L.y, L.direction || 2, 2);
      if (L.hidePlayer) $gamePlayer.setTransparent(true);
      if (L.hideMapName) $gameMap.disableNameDisplay();
      SceneManager.goto(Scene_Map);
      return true;
    },

    mapReady() {
      const s = SceneManager._scene;
      return !!(
        s && sceneName() === 'Scene_Map' && s.isReady() && !SceneManager.isSceneChanging() &&
        !$gamePlayer.isTransferring() && ImageManager.isReady()
      );
    },

    // Snap the view to the map's top-left and clear any screen tint/fade, for a
    // whole-map render.
    frameWholeMap() {
      $gameMap._displayX = 0;
      $gameMap._displayY = 0;
      $gameScreen.clearTone && $gameScreen.clearTone();
      $gameScreen.clearFade && $gameScreen.clearFade();
      return true;
    },

    hideEvents() {
      $gameMap.events().forEach((e) => e.setTransparent(true));
      return true;
    },

    imagesReady() {
      return ImageManager.isReady();
    },

    startEvent(id) {
      const ev = $gameMap.event(id);
      if (!ev) throw new Error('No event ' + id + ' on map ' + $gameMap.mapId());
      log.text = [];
      log.choices = null;
      log.transfer = null;
      ev.start();
      return { name: ev.event().name };
    },

    choiceOpen() {
      const w = SceneManager._scene && SceneManager._scene._messageWindow;
      const c = w && w._choiceWindow;
      return !!(c && c.active);
    },

    busy() {
      const s = sceneName();
      if (s === 'Scene_Battle') return true;
      if (window.$gameMessage && $gameMessage.isBusy()) return true;
      if (s === 'Scene_Map' && $gameMap.isEventRunning()) return true;
      return SceneManager.isSceneChanging();
    },

    // Map-side lines as lines; anything shown in battle separately as
    // battleLines, so a troop's battle-event text doesn't read as the map
    // event's dialogue.
    takeText() {
      const lines = log.text.filter((l) => !l.battle).map((l) => l.text);
      const battleLines = log.text.filter((l) => l.battle).map((l) => l.text);
      const out = { lines, choices: this.choiceOpen() ? log.choices : null };
      if (battleLines.length) out.battleLines = battleLines;
      log.text = [];
      return out;
    },

    peekText() {
      return { lines: log.text.map((l) => l.text), choices: log.choices };
    },

    clearTransfer() {
      log.transfer = null;
      return true;
    },

    takeTransfer() {
      const t = log.transfer;
      log.transfer = null;
      return t;
    },

    // What an event/transfer is doing right now, for settling after walk/startEvent.
    flow() {
      const s = sceneName();
      const onMap = s === 'Scene_Map';
      return {
        scene: s,
        changing: SceneManager.isSceneChanging(),
        transferring: !!(window.$gamePlayer && $gamePlayer.isTransferring()),
        mapReady: onMap ? this.mapReady() : false,
        message: !!(window.$gameMessage && $gameMessage.isBusy()),
        eventRunning: onMap && $gameMap.isEventRunning(),
      };
    },

    choiceCount() {
      return this.choiceOpen() ? $gameMessage.choices().length : 0;
    },

    selectChoice(i) {
      const c = SceneManager._scene._messageWindow._choiceWindow;
      c.select(i);
      return true;
    },

    setBattleSpeed(n) {
      battleSpeed = Math.max(1, Math.floor(n));
      return true;
    },

    setAutoBattle() {
      Game_Actor.prototype.isAutoBattle = function () { return true; };
      return true;
    },

    startBattle(troopId, canEscape, canLose) {
      if (!$dataTroops[troopId]) throw new Error('No troop ' + troopId);
      BattleManager.setup(troopId, canEscape, canLose);
      SceneManager.push(Scene_Battle);
      return true;
    },

    battleSnapshot() {
      return {
        turn: $gameTroop.turnCount(),
        party: $gameParty.members().map((a) => ({ name: a.name(), level: a.level, hp: a.hp, mhp: a.mhp, dead: a.isDead() })),
        enemies: $gameTroop.members().map((e) => ({ name: e.name(), hp: e.hp, mhp: e.mhp, dead: e.isDead() })),
      };
    },

    battleOutcome() {
      if (sceneName() === 'Scene_Gameover' || $gameParty.isAllDead()) return 'defeat';
      if ($gameTroop.isAllDead()) return 'victory';
      if (BattleManager._escaped) return 'escaped';
      return 'ended';
    },

    playerPos() {
      return { mapId: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, moving: $gamePlayer.isMoving() };
    },

    state() {
      const s = sceneName();
      const out = { scene: s };
      if (window.$gamePlayer && $gameMap && $gameMap.mapId()) {
        out.mapId = $gameMap.mapId();
        out.x = $gamePlayer.x;
        out.y = $gamePlayer.y;
        out.direction = $gamePlayer.direction();
        out.gold = $gameParty.gold();
        out.party = $gameParty.members().map((a) => ({ id: a.actorId(), name: a.name(), level: a.level, hp: a.hp, mhp: a.mhp }));
      }
      return out;
    },
  };
})();
`;

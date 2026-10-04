#!/usr/bin/env node
// Run the builders' output through a licensed local MV interpreter and record what it calls.
// The game world (party, actors, screen, audio, battle and scene managers) is replaced by
// spies, so each scenario checks that Game_Interpreter reads every parameter from the slot
// the builder wrote it to. Engine source stays outside this repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const WORLD = `
  var calls = [];
  var sceneChanging = false;
  var inBattle = false;
  var battleCallback = null;
  var Graphics = { frameCount: 0 };
  function record(name, args) { calls.push([name].concat(Array.prototype.slice.call(args))); }
  // Any method call is recorded; listed values answer queries the interpreter makes.
  function spy(name, values) {
    return new Proxy({}, { get: function(_, key) {
      if (typeof key !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
      return function() { record(name + '.' + key, arguments); };
    } });
  }
  function actorSpy(id) {
    return spy('actor' + id, { hp: 100, level: 5, isAlive: function() { return true; },
      isDead: function() { return false; }, currentExp: function() { return 1000; } });
  }
  var actors = [null, actorSpy(1), actorSpy(2)];
  var enemies = [spy('enemy0', {}), spy('enemy1', {}), spy('enemy2', {})];
  var dataEntry = function(kind) { return [null, 1, 2, 3].map(function(id) { return id && { kind: kind, id: id }; }); };
  var $dataItems = dataEntry('item'), $dataWeapons = dataEntry('weapon'), $dataArmors = dataEntry('armor');
  var $dataActors = dataEntry('actor'), $dataTroops = [null, {}, {}, {}, {}, {}, {}];
  // Game_Interpreter.setup preloads animation images for Show Animation's parameters[1].
  var $dataAnimations = []; $dataAnimations[41] = { animation1Name: '', animation2Name: '', animation1Hue: 0, animation2Hue: 0 };
  // Game_Variables ignores IDs past the database's variable count.
  var $dataSystem = { switches: new Array(256), variables: new Array(256) };
  var $gameParty = spy('party', { inBattle: function() { return inBattle; },
    members: function() { return [actors[1], actors[2]]; }, isAllDead: function() { return false; } });
  var $gameActors = { actor: function(id) { return actors[id] || null; } };
  var $gameTroop = spy('troop', { members: function() { return enemies; } });
  var $gameScreen = spy('screen', {});
  var AudioManager = spy('audio', {});
  var ImageManager = spy('image', {});
  var BattleManager = spy('battle', { setEventCallback: function(callback) { battleCallback = callback; } });
  var SceneManager = spy('scene', {
    isSceneChanging: function() { return sceneChanging; },
    push: function(scene) { calls.push(['scene.push', scene.name]); sceneChanging = true; },
  });
  function Scene_Battle() {} function Scene_Shop() {} function Scene_Name() {}
  var $gamePlayer = spy('player', { makeEncounterTroopId: function() { return 5; },
    isTransferring: function() { return false; } });
  var $gameMap = { mapId: function() { return 7; }, requestRefresh: function() {}, refreshIfNeeded: function() {},
    event: function(id) { return spy('event' + id, {}); } };
  var $gameSwitches = new Game_Switches();
  var $gameVariables = new Game_Variables();
  var $gameSelfSwitches = new Game_SelfSwitches();
  var $gameMessage = new Game_Message();
`;

async function main(enginePath) {
  const corePath = join(dirname(enginePath), 'rpg_core.js');
  const [objectsSource, coreSource] = await Promise.all([readFile(enginePath, 'utf8'), readFile(corePath, 'utf8')]);
  assert.match(coreSource, /Utils\.RPGMAKER_NAME\s*=\s*['"]MV['"]/, 'The supplied engine must be RPG Maker MV.');
  const version = coreSource.match(/Utils\.RPGMAKER_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? 'unknown';
  const extensionsSource = coreSource.slice(0, coreSource.indexOf('function Utils()'));
  const { buildEventCommands } = await import('../dist/utils/eventCommandBuilders.js');
  const troopPage = await import('../dist/utils/troopPage.js');
  const build = (kind, parameters) => buildEventCommands({ kind, ...parameters }).commands;
  let passed = 0;

  /** Run commands to completion; `battle` is the result (0 win, 1 escape, 2 lose) handed back after Battle Processing. */
  function run(commands, { variables = {}, battle = 0, troop = false } = {}) {
    const context = vm.createContext({});
    const evaluate = (source) => vm.runInContext(source, context, { timeout: 2000 });
    vm.runInContext(extensionsSource, context, { filename: basename(corePath), timeout: 2000 });
    vm.runInContext(objectsSource, context, { filename: basename(enginePath), timeout: 2000 });
    evaluate(WORLD);
    context.fixture = JSON.stringify({ commands: [...commands, { code: 0, indent: 0, parameters: [] }], variables, troop });
    evaluate(`
      var fixture = JSON.parse(fixture);
      inBattle = fixture.troop;
      Object.keys(fixture.variables).forEach(function(id) { $gameVariables.setValue(Number(id), fixture.variables[id]); });
      var interpreter = new Game_Interpreter();
      interpreter.setup(fixture.commands, 3);
    `);
    for (let frame = 0; frame < 300 && evaluate('interpreter.isRunning()'); frame++) {
      evaluate('Graphics.frameCount++; interpreter.update();');
      if (evaluate('sceneChanging')) {
        context.outcome = battle;
        evaluate('sceneChanging = false; if (battleCallback) { battleCallback(outcome); battleCallback = null; }');
      }
    }
    assert.equal(evaluate('interpreter.isRunning()'), false, 'Event did not finish within 300 simulated frames.');
    return JSON.parse(evaluate('JSON.stringify(calls)'));
  }
  const only = (calls, prefix) => calls.filter(([name]) => name.startsWith(prefix));
  function check(name, execute) {
    execute();
    passed++;
    console.log(`PASS ${name}`);
  }

  check('change_gold adds a constant and subtracts a variable', () => {
    assert.deepEqual(only(run(build('change_gold', { amount: 50 })), 'party.gain'), [['party.gainGold', 50]]);
    assert.deepEqual(only(run(build('change_gold', { amountVariableId: 4, decrease: true }), { variables: { 4: 30 } }), 'party.gain'),
      [['party.gainGold', -30]]);
  });

  check('change_items reaches the right database with includeEquip', () => {
    assert.deepEqual(only(run(build('change_items', { itemId: 1, amount: 2 })), 'party.gain'),
      [['party.gainItem', { kind: 'item', id: 1 }, 2]]);
    assert.deepEqual(only(run(build('change_items', { itemType: 'weapon', itemId: 2, amount: 3, decrease: true, includeEquip: true })), 'party.gain'),
      [['party.gainItem', { kind: 'weapon', id: 2 }, -3, true]]);
    assert.deepEqual(only(run(build('change_items', { itemType: 'armor', itemId: 3, amount: 1 })), 'party.gain'),
      [['party.gainItem', { kind: 'armor', id: 3 }, 1, false]]);
  });

  check('change_party_member adds with initialize and removes', () => {
    const added = run(build('change_party_member', { actorId: 2, initialize: true }));
    assert.deepEqual(added.filter(([name]) => name === 'actor2.setup' || name.startsWith('party.')), [['actor2.setup', 2], ['party.addActor', 2]]);
    assert.deepEqual(only(run(build('change_party_member', { actorId: 2, remove: true })), 'party.'), [['party.removeActor', 2]]);
  });

  check('play_audio plays on the requested channel', () => {
    const track = { name: 'Theme1', pan: -10, pitch: 120, volume: 80 };
    for (const [channel, method] of [['bgm', 'playBgm'], ['bgs', 'playBgs'], ['me', 'playMe'], ['se', 'playSe']]) {
      assert.deepEqual(only(run(build('play_audio', { channel, name: 'Theme1', volume: 80, pitch: 120, pan: -10 })), 'audio.'),
        [[`audio.${method}`, track]]);
    }
  });

  check('screen_effect drives fade, tint, flash and shake', () => {
    assert.deepEqual(only(run(build('screen_effect', { effect: 'fadeout' })), 'screen.'), [['screen.startFadeOut', 24]]);
    assert.deepEqual(only(run(build('screen_effect', { effect: 'fadein' })), 'screen.'), [['screen.startFadeIn', 24]]);
    assert.deepEqual(only(run(build('screen_effect', { effect: 'tint', color: [-68, -68, 0, 68], duration: 30 })), 'screen.'),
      [['screen.startTint', [-68, -68, 0, 68], 30]]);
    assert.deepEqual(only(run(build('screen_effect', { effect: 'flash', color: [255, 255, 255, 170], duration: 8, wait: false })), 'screen.'),
      [['screen.startFlash', [255, 255, 255, 170], 8]]);
    assert.deepEqual(only(run(build('screen_effect', { effect: 'shake', power: 7, speed: 3, duration: 30 })), 'screen.'),
      [['screen.startShake', 7, 3, 30]]);
  });

  check('show_picture reads origin, variable coordinates, scale, opacity and blend', () => {
    const calls = run(build('show_picture', {
      pictureId: 1, name: 'Title', origin: 'center', designation: 'variable', x: 3, y: 4, scaleX: 50, scaleY: 75, opacity: 128, blend: 'additive',
    }), { variables: { 3: 408, 4: 312 } });
    assert.deepEqual(only(calls, 'screen.'), [['screen.showPicture', 1, 'Title', 1, 408, 312, 50, 75, 128, 1]]);
    assert.deepEqual(only(run(build('erase_picture', { pictureId: 1 })), 'screen.'), [['screen.erasePicture', 1]]);
  });

  check('show_animation and show_balloon target the player and map events', () => {
    assert.deepEqual(only(run(build('show_animation', { characterId: -1, animationId: 41 })), 'player.request'),
      [['player.requestAnimation', 41]]);
    assert.deepEqual(only(run(build('show_balloon', { characterId: 5, balloonId: 1 })), 'event5.'), [['event5.requestBalloon', 1]]);
    assert.deepEqual(only(run(build('show_balloon', { balloonId: 2 })), 'event3.'), [['event3.requestBalloon', 2]]);
  });

  check('battle_processing sets up the troop and runs only the matching result branch', () => {
    const fragment = build('battle_processing', {
      troopId: 3, canEscape: true, canLose: true,
      winBranch: build('change_gold', { amount: 100 }), escapeBranch: build('change_gold', { amount: 2 }),
      loseBranch: build('change_gold', { amount: 1 }),
    });
    for (const [outcome, gold] of [[0, 100], [1, 2], [2, 1]]) {
      const calls = run(fragment, { battle: outcome });
      assert.deepEqual(only(calls, 'battle.setup'), [['battle.setup', 3, true, true]]);
      assert.deepEqual(only(calls, 'party.gainGold'), [['party.gainGold', gold]]);
    }
    assert.deepEqual(only(run(build('battle_processing', { randomEncounter: true })), 'battle.setup'), [['battle.setup', 5, false, false]]);
    assert.deepEqual(only(run(build('battle_processing', { troopVariableId: 9 }), { variables: { 9: 4 } }), 'battle.setup'),
      [['battle.setup', 4, false, false]]);
  });

  check('shop_processing hands the engine every good and purchase-only', () => {
    const calls = run(build('shop_processing', { goods: [{ id: 1 }, { type: 'weapon', id: 2, price: 300 }], purchaseOnly: true }));
    assert.deepEqual(only(calls, 'scene.'), [
      ['scene.push', 'Scene_Shop'],
      ['scene.prepareNextScene', [[0, 1, 0, 0, true], [1, 2, 1, 300]], true],
    ]);
  });

  check('name_input opens the name scene for the actor and length', () => {
    assert.deepEqual(only(run(build('name_input', { actorId: 1, maxLength: 6 })), 'scene.'),
      [['scene.push', 'Scene_Name'], ['scene.prepareNextScene', 1, 6]]);
  });

  check('change_actor reaches the party, a variable-chosen actor and each stat', () => {
    assert.deepEqual(only(run(build('change_actor', { stat: 'hp', actorId: 0, amount: 10, decrease: true })), 'actor').filter(([n]) => n.endsWith('gainHp')),
      [['actor1.gainHp', -10], ['actor2.gainHp', -10]]);
    assert.deepEqual(only(run(build('change_actor', { stat: 'mp', actorVariableId: 5, amount: 20 }), { variables: { 5: 2 } }), 'actor'),
      [['actor2.gainMp', 20]]);
    assert.deepEqual(only(run(build('change_actor', { stat: 'exp', actorId: 1, amount: 100, showLevelUp: true })), 'actor'),
      [['actor1.changeExp', 1100, true]]);
    assert.deepEqual(only(run(build('change_actor', { stat: 'level', actorId: 1, amountVariableId: 2 }), { variables: { 2: 3 } }), 'actor'),
      [['actor1.changeLevel', 8, false]]);
    assert.deepEqual(only(run(build('change_actor', { stat: 'state', actorId: 1, stateId: 4, remove: true })), 'actor1.removeState'),
      [['actor1.removeState', 4]]);
    assert.deepEqual(only(run(build('change_actor', { stat: 'recover_all', actorId: 0 })), 'actor'),
      [['actor1.recoverAll'], ['actor2.recoverAll']]);
  });

  check('troop commands address enemy slots and abort the battle', () => {
    assert.deepEqual(only(run(build('enemy_appear', { enemyIndex: 2 }), { troop: true }), 'enemy'), [['enemy2.appear']]);
    const states = only(run(build('change_enemy_state', { enemyIndex: -1, stateId: 1 }), { troop: true }), 'enemy').filter(([n]) => n.endsWith('addState'));
    assert.deepEqual(states, [['enemy0.addState', 1], ['enemy1.addState', 1], ['enemy2.addState', 1]]);
    assert.deepEqual(only(run(build('abort_battle', {}), { troop: true }), 'battle.'), [['battle.abort']]);
  });

  /** A fresh engine context, for checks that call engine functions directly instead of running an event. */
  function engine() {
    const context = vm.createContext({});
    vm.runInContext(extensionsSource, context, { filename: basename(corePath), timeout: 2000 });
    vm.runInContext(objectsSource, context, { filename: basename(enginePath), timeout: 2000 });
    vm.runInContext(WORLD, context, { timeout: 2000 });
    return (source) => vm.runInContext(source, context, { timeout: 2000 });
  }

  check('move_route hands the character its route, and every step name is the engine constant', () => {
    const steps = [
      'move_down', 'move_left', 'move_right', 'move_up', 'move_lower_l', 'move_lower_r', 'move_upper_l', 'move_upper_r',
      'move_random', 'move_toward', 'move_away', 'move_forward', 'move_backward', 'turn_down', 'turn_left', 'turn_right',
      'turn_up', 'turn_90d_r', 'turn_90d_l', 'turn_180d', 'turn_90d_r_l', 'turn_random', 'turn_toward', 'turn_away',
      'walk_anime_on', 'walk_anime_off', 'step_anime_on', 'step_anime_off', 'dir_fix_on', 'dir_fix_off',
      'through_on', 'through_off', 'transparent_on', 'transparent_off',
    ].map((step) => ({ step }));
    steps.push({ step: 'jump', x: 1, y: 2 }, { step: 'wait', frames: 3 }, { step: 'switch_on', switchId: 4 },
      { step: 'switch_off', switchId: 4 }, { step: 'change_speed', value: 5 }, { step: 'change_freq', value: 3 },
      { step: 'change_image', name: 'Actor1', index: 2 }, { step: 'change_opacity', value: 128 },
      { step: 'change_blend_mode', value: 1 }, { step: 'play_se', name: 'Jump1' }, { step: 'script', text: 'x' });
    const forced = only(run(build('move_route', { characterId: -1, steps, repeat: true })), 'player.forceMoveRoute');
    assert.equal(forced.length, 1);
    const route = forced[0][1];
    assert.equal(route.repeat, true);
    assert.equal(route.list.length, steps.length + 1);
    const evaluate = engine();
    steps.forEach(({ step }, i) => {
      assert.equal(route.list[i].code, evaluate(`Game_Character.ROUTE_${step.toUpperCase()}`), `${step} code`);
    });
    assert.equal(route.list.at(-1).code, evaluate('Game_Character.ROUTE_END'));
  });

  check('troop pages trigger exactly when Game_Troop.meetsConditions says they should', () => {
    const { buildTroopPage } = troopPage;
    const evaluate = engine();
    evaluate(`
      var hp = { enemy1: 0.4, actor1: 0.6 }, turnEnd = false;
      $gameTroop = { members: function() { return [{ hpRate: function() { return 1; } }, { hpRate: function() { return hp.enemy1; } }]; } };
      $gameActors = { actor: function(id) { return id === 1 ? { hpRate: function() { return hp.actor1; } } : null; } };
      BattleManager = { isTurnEnd: function() { return turnEnd; } };
    `);
    const meets = (when, turn = 1, state = '') => {
      evaluate(`$gameSwitches = new Game_Switches(); hp = { enemy1: 0.4, actor1: 0.6 }; turnEnd = false; ${state}`);
      return evaluate(`Game_Troop.prototype.meetsConditions.call({ _turnCount: ${turn} }, ${JSON.stringify(buildTroopPage({ when }).page)})`);
    };
    assert.deepEqual([1, 2, 3, 4, 5, 8].map((turn) => meets({ turn: [2, 3] }, turn)), [false, true, false, false, true, true]);
    assert.deepEqual([0, 1, 2].map((turn) => meets({ turn: [1, 0] }, turn)), [false, true, false]);
    assert.equal(meets({ enemyHpBelow: [1, 50] }), true);
    assert.equal(meets({ enemyHpBelow: [1, 30] }), false);
    assert.equal(meets({ enemyHpBelow: [0, 50] }), false);
    assert.equal(meets({ actorHpBelow: [1, 60] }), true);
    assert.equal(meets({ actorHpBelow: [1, 59] }), false);
    assert.equal(meets({ switchId: 3 }), false);
    assert.equal(meets({ switchId: 3 }, 1, '$gameSwitches.setValue(3, true);'), true);
    assert.equal(meets({ turnEnd: true }), false);
    assert.equal(meets({ turnEnd: true }, 1, 'turnEnd = true;'), true);
    assert.equal(meets({ turn: [2, 0], enemyHpBelow: [1, 50] }, 2), true);
    assert.equal(meets({ turn: [2, 0], enemyHpBelow: [1, 30] }, 2), false);
    // A page with every check off never runs, which is why buildTroopPage refuses one.
    assert.equal(evaluate('Game_Troop.prototype.meetsConditions.call({ _turnCount: 1 }, { conditions: {} })'), false);
  });

  console.log(`Verified ${passed} scenarios against RPG Maker MV ${version}.`);
  console.log(`rpg_objects.js SHA256 ${createHash('sha256').update(objectsSource).digest('hex')}`);
  console.log('Interpreter with a spied game world: renderer, scenes, audio playback and battle AI are not exercised.');
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--engine') {
  console.error('Usage: node scripts/verify-mv-command-effects.mjs --engine /path/to/project/js/rpg_objects.js');
  console.error('Run npm run build first. Requires the sibling rpg_core.js from your licensed MV project.');
  process.exitCode = 1;
} else {
  await main(resolve(args[1]));
}

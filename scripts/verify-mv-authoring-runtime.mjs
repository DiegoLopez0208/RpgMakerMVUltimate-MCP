#!/usr/bin/env node
// The licensed MV engine is read locally; no engine or project files are copied or changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--engine') {
  console.error('Usage: node scripts/verify-mv-authoring-runtime.mjs --engine /path/to/js/rpg_objects.js');
  console.error('Run npm run build first. The sibling rpg_core.js must belong to your licensed MV engine.');
  process.exitCode = 1;
} else {
  await main(resolve(args[1]));
}

async function main(enginePath) {
  const corePath = join(dirname(enginePath), 'rpg_core.js');
  const [objectsSource, coreSource] = await Promise.all([readFile(enginePath, 'utf8'), readFile(corePath, 'utf8')]);
  assert.match(coreSource, /Utils\.RPGMAKER_NAME\s*=\s*['"]MV['"]/);
  const version = coreSource.match(/Utils\.RPGMAKER_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const extensionEnd = coreSource.indexOf('function Utils()');
  assert.ok(extensionEnd > 0);
  const b = await import('../dist/parity/events/commandBuilders.js');
  const { buildTroopPage } = await import('../dist/parity/tools/battleTools.js');
  const { createMoveRoute, moveRouteCommands } = await import('../dist/parity/tools/moveTools.js');
  const end = { code: 0, indent: 0, parameters: [] };
  const amount = value => ({ type: 'constant', value });
  const fixed = actorId => ({ type: 'fixed', actorId });
  let passed = 0;

  function run(commands, options = {}) {
    const context = vm.createContext({});
    const evaluate = source => vm.runInContext(source, context, { timeout: 2000 });
    vm.runInContext(coreSource.slice(0, extensionEnd), context, { filename: basename(corePath), timeout: 2000 });
    vm.runInContext(objectsSource, context, { filename: basename(enginePath), timeout: 2000 });
    context.fixtureJson = JSON.stringify({ commands: [...commands, end], ...options });
    evaluate(`
      var fixture = JSON.parse(fixtureJson);
      var Graphics = { frameCount: 0 };
      var scenes = [], preparations = [], audioCalls = [], battleCalls = [], aborted = 0;
      function Scene_Battle() {} function Scene_Shop() {} function Scene_Name() {}
      var SceneManager = {
        isSceneChanging: function() { return false; },
        push: function(scene) { scenes.push(scene.name); },
        prepareNextScene: function() { preparations.push(Array.prototype.slice.call(arguments)); }
      };
      var ImageManager = { requestFace: function() {}, requestCharacter: function() {}, requestPicture: function() {}, requestAnimation: function() {} };
      var AudioManager = {};
      ['playBgm','playBgs','playMe','playSe'].forEach(function(method) {
        AudioManager[method] = function(track) { audioCalls.push([method, track]); };
      });
      var SoundManager = { playActorCollapse: function() {}, playEnemyCollapse: function() {} };
      var BattleManager = {
        setup: function(id, escape, lose) { battleCalls.push([id, escape, lose]); },
        setEventCallback: function(callback) { callback(fixture.battleResult || 0); },
        abort: function() { aborted++; }
      };
      var $dataSystem = { switches: new Array(256), variables: new Array(256), partyMembers: [1,2], optExtraExp: false, equipTypes: ['', 'Weapon', 'Shield', 'Head', 'Body', 'Accessory'] };
      var $dataActors = [null];
      [1,2,3].forEach(function(id) { $dataActors.push({
        id: id, name: 'Actor'+id, nickname: '', profile: '', classId: 1,
        initialLevel: 1, maxLevel: 99, characterName: '', characterIndex: 0,
        faceName: '', faceIndex: 0, battlerName: '', equips: [0,0,0,0,0], traits: []
      }); });
      var $dataClasses = [null, { id: 1, expParams: [30,20,30,30], learnings: [], traits: [],
        params: [100,40,10,10,10,10,10,10].map(function(value) { return new Array(100).fill(value); }) }];
      var $dataStates = [null,
        { id: 1, restriction: 4, priority: 100, traits: [], minTurns: 1, maxTurns: 1, autoRemovalTiming: 0 },
        { id: 2, restriction: 0, priority: 50, traits: [], minTurns: 2, maxTurns: 2, autoRemovalTiming: 0 }];
      var $dataItems = [null, { id: 1, name: 'Potion', itypeId: 1, price: 10 }];
      var $dataWeapons = [null, { id: 1, name: 'Sword', wtypeId: 1, etypeId: 1, traits: [], params: [0,0,0,0,0,0,0,0] }];
      var $dataArmors = [null, { id: 1, name: 'Armor', atypeId: 1, etypeId: 2, traits: [], params: [0,0,0,0,0,0,0,0] }];
      var $dataSkills = [null];
      var $dataAnimations = new Array(8);
      $dataAnimations[7] = { id: 7, animation1Name: '', animation2Name: '', animation1Hue: 0, animation2Hue: 0 };
      var $dataEnemies = [null, { id: 1, name: 'Slime', params: [100,30,10,10,10,10,10,10], traits: [], actions: [], dropItems: [], exp: 1, gold: 1 }];
      var $dataTroops = [null, { id: 1, members: [{ enemyId: 1, x: 0, y: 0, hidden: true }], pages: [] }];
      var $dataCommonEvents = [];
      var DataManager = {
        isItem: function(item) { return $dataItems.indexOf(item) >= 0; },
        isWeapon: function(item) { return $dataWeapons.indexOf(item) >= 0; },
        isArmor: function(item) { return $dataArmors.indexOf(item) >= 0; },
        isSkill: function(item) { return $dataSkills.indexOf(item) >= 0; }
      };
      var $gameMap = { mapId: function() { return 1; }, requestRefresh: function() {}, refreshIfNeeded: function() {} };
      var $gameSystem = { isCJK: function() { return false; }, isSideView: function() { return false; } };
      var $gameTemp = { isCommonEventReserved: function() { return false; } };
      var $gameSwitches = new Game_Switches(), $gameVariables = new Game_Variables();
      var $gameSelfSwitches = new Game_SelfSwitches(), $gameMessage = new Game_Message();
      var $gameActors = new Game_Actors(), $gameParty = new Game_Party();
      var $gameScreen = new Game_Screen(), $gameTroop = new Game_Troop();
      var $gamePlayer = new Game_Character();
      $gamePlayer.refresh = function() {};
      $gamePlayer.makeEncounterCount = function() {};
      $gamePlayer.makeEncounterTroopId = function() { return 1; };
      $gameParty.setupStartingMembers();
      $gameTroop.setup(1);
      Object.keys(fixture.variables || {}).forEach(function(id) { $gameVariables.setValue(Number(id), fixture.variables[id]); });
      if (fixture.inBattle) $gameParty._inBattle = true;
      var interpreter = new Game_Interpreter();
      interpreter.setup(fixture.commands, 1);
    `);
    const snapshot = expression => JSON.parse(evaluate(`JSON.stringify(${expression})`));
    const messages = [];
    for (let frame = 0; frame < 300 && evaluate('interpreter.isRunning()'); frame++) {
      evaluate('Graphics.frameCount++; interpreter.update();');
      if (evaluate('$gameMessage.isBusy()')) {
        messages.push(snapshot('$gameMessage._texts'));
        evaluate('$gameMessage.clear();');
      }
      evaluate('if ($gamePlayer.isMoveRouteForcing()) $gamePlayer.updateRoutineMove();');
    }
    assert.equal(evaluate('interpreter.isRunning()'), false, 'Event did not finish within 300 frames');
    return { evaluate, snapshot, messages };
  }

  function check(name, scenario) {
    scenario();
    passed++;
    console.log(`PASS ${name}`);
  }

  check('gold builder changes real MV party gold using constants and variables', () => {
    const r = run([b.changeGold('increase', amount(25)), b.changeGold('decrease', { type: 'variable', variableId: 1 })], { variables: { 1: 7 } });
    assert.equal(r.evaluate('$gameParty.gold()'), 18);
  });
  check('inventory builders change real MV item, weapon and armor inventories', () => {
    const r = run([b.changeItems(1, 'increase', amount(5)), b.changeItems(1, 'decrease', amount(2)),
      b.changeWeapons(1, 'increase', amount(2)), b.changeArmors(1, 'increase', amount(3))]);
    assert.deepEqual(r.snapshot('[$gameParty.numItems($dataItems[1]),$gameParty.numItems($dataWeapons[1]),$gameParty.numItems($dataArmors[1])]'), [3,2,3]);
  });
  check('party builder removes and initializes real MV actors', () => {
    const r = run([b.changePartyMember(2, 'remove'), b.changePartyMember(3, 'add', true)]);
    assert.deepEqual(r.snapshot('$gameParty.members().map(function(actor){return actor.actorId();})'), [1,3]);
    assert.equal(r.evaluate('$gameActors.actor(3).hp'), 100);
  });
  check('audio builder reaches the correct MV audio channel with unchanged settings', () => {
    const r = run(['bgm','bgs','me','se'].map(kind => b.playAudio(kind, { name: 'Track', volume: 70, pitch: 120, pan: -10 })));
    assert.deepEqual(r.snapshot('audioCalls'), ['playBgm','playBgs','playMe','playSe'].map(method => [method, { name: 'Track', volume: 70, pitch: 120, pan: -10 }]));
  });
  check('screen builders alter real MV screen tone, flash, shake and fade state', () => {
    const r = run([b.tintScreen([-20,10,30,0], 0, false), b.flashScreen([10,20,30,40], 30, false), b.shakeScreen(4,6,30,false), b.fadeScreen('out')]);
    assert.deepEqual(r.snapshot('$gameScreen.tone()'), [-20,10,30,0]);
    assert.deepEqual(r.snapshot('$gameScreen.flashColor()'), [10,20,30,40]);
    assert.deepEqual(r.snapshot('[$gameScreen._shakePower,$gameScreen._shakeSpeed,$gameScreen._shakeDuration]'), [4,6,30]);
    r.evaluate('for(var i=0;i<30;i++) $gameScreen.update();');
    assert.equal(r.evaluate('$gameScreen.brightness()'), 0);
  });
  check('picture builder creates real MV picture properties and erases the slot', () => {
    const r = run([b.showPicture(2,'Portrait',{ origin:'center',x:120,y:90,scaleX:80,scaleY:90,opacity:200,blend:'additive' })]);
    assert.deepEqual(r.snapshot('(function(p){return [p.name(),p.origin(),p.x(),p.y(),p.scaleX(),p.scaleY(),p.opacity(),p.blendMode()];})($gameScreen.picture(2))'), ['Portrait',1,120,90,80,90,200,1]);
    const erased = run([b.showPicture(2,'Portrait'),b.erasePicture(2)]);
    assert.equal(erased.evaluate('$gameScreen.picture(2)'), null);
  });
  check('character effects request MV animation and balloon ids on a real character', () => {
    const r = run([b.showAnimation(-1,7,false),b.showBalloon(-1,2,false)]);
    assert.deepEqual(r.snapshot('[$gamePlayer.animationId(),$gamePlayer.balloonId()]'), [7,2]);
  });
  check('battle builder selects direct/variable/random troops and real MV result branches', () => {
    for (const result of [0,1,2]) {
      const branches = [];
      for (const [code, value] of [[601,10],[602,20],[603,30]]) {
        branches.push({ code, indent:0, parameters:[] }, b.controlVariables(1,'set',amount(value),{indent:1}), {code:0,indent:1,parameters:[]});
      }
      branches.push({code:604,indent:0,parameters:[]});
      const r = run([b.battleProcessing({type:'direct',troopId:1},true,true),...branches], {battleResult:result});
      assert.equal(r.evaluate('$gameVariables.value(1)'), [10,20,30][result]);
      assert.deepEqual(r.snapshot('battleCalls'), [[1,true,true]]);
    }
    for (const troop of [{type:'variable',variableId:2},{type:'random'}]) {
      assert.deepEqual(run([b.battleProcessing(troop)],{variables:{2:1}}).snapshot('battleCalls'), [[1,false,false]]);
    }
  });
  check('shop builder feeds all continuation goods and purchase-only flag into MV scene preparation', () => {
    const r = run(b.shopProcessing([{kind:'item',id:1},{kind:'weapon',id:1,price:25},{kind:'armor',id:1,price:0}],true));
    assert.deepEqual(r.snapshot('scenes'), ['Scene_Shop']);
    assert.deepEqual(r.snapshot('preparations'), [[[[0,1,0,0,true],[1,1,1,25],[2,1,1,0]],true]]);
  });
  check('name builder requests MV name-entry scene for the correct actor and length', () => {
    const r = run([b.nameInput(2,12)]);
    assert.deepEqual(r.snapshot('scenes'), ['Scene_Name']);
    assert.deepEqual(r.snapshot('preparations'), [[2,12]]);
  });
  check('actor builders change real MV HP, MP, states, EXP, levels and recovery', () => {
    const r = run([b.changeHp(fixed(0),'decrease',amount(20)),b.changeMp({type:'variable',variableId:1},'decrease',amount(7)),b.changeState(fixed(1),'add',2)],{variables:{1:2}});
    assert.deepEqual(r.snapshot('[$gameActors.actor(1).hp,$gameActors.actor(2).hp,$gameActors.actor(2).mp,$gameActors.actor(1).isStateAffected(2)]'),[80,80,33,true]);
    const recovered = run([b.changeHp(fixed(1),'decrease',amount(99)),b.changeState(fixed(1),'add',2),b.recoverAll(fixed(1))]);
    assert.deepEqual(recovered.snapshot('[$gameActors.actor(1).hp,$gameActors.actor(1).isStateAffected(2)]'),[100,false]);
    assert.equal(run([b.changeExp(fixed(1),'increase',amount(5))]).evaluate('$gameActors.actor(1).currentExp()'),5);
    assert.equal(run([b.changeLevel(fixed(1),'increase',amount(2))]).evaluate('$gameActors.actor(1).level'),3);
  });
  check('battle commands reveal a real hidden MV enemy, alter its states and request battle abort', () => {
    const r = run([b.enemyAppear(0),b.changeEnemyState(-1,'add',2),b.abortBattle()],{inBattle:true});
    assert.deepEqual(r.snapshot('[$gameTroop.members()[0].isHidden(),$gameTroop.members()[0].isStateAffected(2),aborted]'),[false,true,1]);
  });
  check('forced movement executes real MV route steps and waits until completion', () => {
    const route = createMoveRoute('custom',{ commands:[{code:29,parameters:[5]},{code:42,parameters:[123]},{code:18,parameters:[]}],wait:true });
    const r = run(moveRouteCommands(-1,route));
    assert.deepEqual(r.snapshot('[$gamePlayer.moveSpeed(),$gamePlayer.opacity(),$gamePlayer.direction(),$gamePlayer.isMoveRouteForcing()]'),[5,123,6,false]);
    assert.ok(r.evaluate('Graphics.frameCount') >= 4);
  });
  check('built troop conditions are interpreted by real MV Game_Troop.meetsConditions', () => {
    const page = buildTroopPage({turn:[1,2],enemyHpBelow:[0,50]},'turn');
    const r = run([]);
    r.evaluate(`var page = ${JSON.stringify(page)}; $gameTroop._turnCount=1; $gameTroop.members()[0].setHp(50);`);
    assert.equal(r.evaluate('$gameTroop.meetsConditions(page)'),true);
    r.evaluate('$gameTroop._turnCount=2;');
    assert.equal(r.evaluate('$gameTroop.meetsConditions(page)'),false);
    r.evaluate('$gameTroop._turnCount=3; $gameTroop.members()[0].setHp(51);');
    assert.equal(r.evaluate('$gameTroop.meetsConditions(page)'),false);
  });
  check('wrapped MV messages execute as separate boxes with at most four lines', () => {
    const commands = b.showText(['A watchman waits beside the gate. '.repeat(15)],{faceName:'Actor1',wrap:true});
    assert.ok(commands.filter(c=>c.code===101).every(c=>c.parameters.length===4));
    const r = run(commands);
    assert.ok(r.messages.length > 1);
    assert.ok(r.messages.every(lines=>lines.length<=4));
  });
  console.log(`Verified ${passed} authoring scenarios against RPG Maker MV ${version}.`);
  console.log(`rpg_objects.js SHA256 ${createHash('sha256').update(objectsSource).digest('hex')}`);
  console.log(`rpg_core.js SHA256 ${createHash('sha256').update(coreSource).digest('hex')}`);
  console.log('Real MV interpreter, party/actor/enemy/screen/character state. Scene, audio and renderer boundaries are stubbed; no GUI, audio output, plugin or full-battle acceptance is claimed.');
}

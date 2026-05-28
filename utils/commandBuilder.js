/**
 * commandBuilder.js — RPG Maker MV Event Command Builder
 *
 * CRITICAL MODULE: Provides the `cmd` object with functions that generate
 * valid RPG Maker MV event command objects {code, indent, parameters}.
 *
 * Each command corresponds to a specific event command code used by
 * RPG Maker MV's event system. These commands are stored in the
 * `list` array of each event page.
 *
 * Reference: https://rpgmaker.net/commands/RMMV/
 */

/**
 * Show Text — code 101 (header) + code 401 (text lines) + code 0 (terminator)
 * Displays a message box with the given text. If faceName is provided,
 * shows the specified face graphic.
 * @param {string} text - The message text (can contain \n for multiple lines)
 * @param {string} faceName - Face graphic filename (empty string for no face)
 * @param {number} faceIndex - Face index in the graphic (0-7)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function message(text, faceName, faceIndex) {
  faceName = faceName || '';
  faceIndex = faceIndex || 0;
  const lines = text.split('\n');
  const commands = [
    { code: 101, indent: 0, parameters: [faceName, faceIndex, 0, 2] }
  ];
  for (const line of lines) {
    commands.push({ code: 401, indent: 0, parameters: [line] });
  }
  commands.push({ code: 0, indent: 0, parameters: [] });
  return commands;
}

/**
 * Show Choices — code 102
 * Presents a choice dialog to the player. Each choice branch is
 * handled by code 402 (BranchChoice) followed by code 404 (EndChoices).
 * @param {string[]} options - Array of choice text strings
 * @param {number} cancelType - Cancel behavior (0=disallowed, 1-6=branch index, -1=cancel branch)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function choice(options, cancelType) {
  cancelType = cancelType !== undefined ? cancelType : -1;
  return [
    { code: 102, indent: 0, parameters: [options, cancelType] }
  ];
}

/**
 * Branch Choice — code 402
 * Marks the start of a choice branch. Must appear inside a Show Choices block.
 * @param {number} index - The choice index this branch handles
 * @param {string} label - The choice text label
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function branchChoice(index, label) {
  return [
    { code: 402, indent: 0, parameters: [index, label] }
  ];
}

/**
 * End Choices — code 404
 * Marks the end of a Show Choices block.
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function endChoices() {
  return [
    { code: 404, indent: 0, parameters: [] }
  ];
}

/**
 * Conditional Branch: Switch — code 111, type 0
 * Checks if a game switch is ON or OFF. Commands inside the branch
 * have indent+1. Follow with endConditional (code 412).
 * @param {number} switchId - The switch ID to check
 * @param {boolean} value - true = ON, false = OFF
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function conditionalSwitch(switchId, value) {
  value = value !== undefined ? value : true;
  return [
    { code: 111, indent: 0, parameters: [0, switchId, value ? 0 : 1] }
  ];
}

/**
 * Conditional Branch: Self Switch — code 111, type 2
 * Checks if a self switch (A/B/C/D) is ON or OFF.
 * @param {string} key - Self switch key: "A", "B", "C", or "D"
 * @param {boolean} value - true = ON, false = OFF
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function conditionalSelfSwitch(key, value) {
  value = value !== undefined ? value : true;
  return [
    { code: 111, indent: 0, parameters: [2, key, value ? 0 : 1] }
  ];
}

/**
 * Conditional Branch: Variable — code 111, type 1
 * Checks a game variable against a value using an operator.
 * @param {number} varId - The variable ID to check
 * @param {number} operator - Comparison: 0=eq, 1=ge, 2=le, 3=gt, 4=lt, 5=ne
 * @param {number} val - The value to compare against
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function conditionalVariable(varId, operator, val) {
  return [
    { code: 111, indent: 0, parameters: [1, varId, operator, val] }
  ];
}

/**
 * End Conditional — code 412
 * Marks the end of a Conditional Branch block.
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function endConditional() {
  return [
    { code: 412, indent: 0, parameters: [] }
  ];
}

/**
 * Control Switches — code 121
 * Turns a game switch ON or OFF.
 * @param {number} id - The switch ID to control
 * @param {boolean} value - true = ON (0), false = OFF (1)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function switchControl(id, value) {
  value = value !== undefined ? value : true;
  return [
    { code: 121, indent: 0, parameters: [id, id, value ? 0 : 1] }
  ];
}

/**
 * Control Self Switch — code 123
 * Turns a self switch (A/B/C/D) ON or OFF for the current event.
 * @param {string} key - Self switch key: "A", "B", "C", or "D"
 * @param {boolean} value - true = ON (0), false = OFF (1)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function selfSwitchControl(key, value) {
  value = value !== undefined ? value : true;
  return [
    { code: 123, indent: 0, parameters: [key, value ? 0 : 1] }
  ];
}

/**
 * Control Variables — code 122
 * Performs an operation on a game variable.
 * @param {number} id - The variable ID
 * @param {number} opType - Operation: 0=set, 1=add, 2=sub, 3=mul, 4=div, 5=mod
 * @param {number} val - The operand value (used with operand type 0 = constant)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function variableControl(id, opType, val) {
  return [
    { code: 122, indent: 0, parameters: [id, id, opType, 0, val] }
  ];
}

/**
 * Change Items — code 126
 * Adds or removes an item from the party inventory.
 * @param {number} itemId - The item ID
 * @param {number} amount - Quantity (positive = add)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function giveItem(itemId, amount) {
  amount = amount || 1;
  return [
    { code: 126, indent: 0, parameters: [itemId, 0, 0, amount] }
  ];
}

/**
 * Change Weapons — code 127
 * Adds or removes a weapon from the party inventory.
 * @param {number} weaponId - The weapon ID
 * @param {number} amount - Quantity to add
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function giveWeapon(weaponId, amount) {
  amount = amount || 1;
  return [
    { code: 127, indent: 0, parameters: [weaponId, 0, 0, amount] }
  ];
}

/**
 * Change Armors — code 128
 * Adds or removes an armor from the party inventory.
 * @param {number} armorId - The armor ID
 * @param {number} amount - Quantity to add
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function giveArmor(armorId, amount) {
  amount = amount || 1;
  return [
    { code: 128, indent: 0, parameters: [armorId, 0, 0, amount] }
  ];
}

/**
 * Change Gold — code 125
 * Adds or subtracts gold from the party.
 * @param {number} amount - Amount of gold (positive to add)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function giveMoney(amount) {
  return [
    { code: 125, indent: 0, parameters: [0, 0, amount] }
  ];
}

/**
 * Transfer Player — code 201
 * Teleports the player to a new map position.
 * @param {number} mapId - Destination map ID
 * @param {number} x - Destination X coordinate
 * @param {number} y - Destination Y coordinate
 * @param {number} direction - Direction after transfer (0=retain, 2=down, 4=left, 6=right, 8=up)
 * @param {number} fadeType - Fade type (0=black, 1=white, 2=none)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function teleport(mapId, x, y, direction, fadeType) {
  direction = direction || 0;
  fadeType = fadeType || 0;
  return [
    { code: 201, indent: 0, parameters: [0, mapId, x, y, direction, fadeType] }
  ];
}

/**
 * Show Animation — code 212
 * Plays an animation on a character or event.
 * @param {number} eventId - Event ID (0 = player, -1 = this event)
 * @param {number} animId - Animation ID from the database
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function showAnimation(eventId, animId) {
  return [
    { code: 212, indent: 0, parameters: [eventId, animId] }
  ];
}

/**
 * Play BGM — code 241
 * Plays a background music track.
 * @param {string} name - BGM filename
 * @param {number} volume - Volume (0-100)
 * @param {number} pitch - Pitch (50-200)
 * @param {number} pan - Pan (-100 to 100)
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function playBGM(name, volume, pitch, pan) {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 241, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

/**
 * Fadeout BGM — code 242
 * Fades out the currently playing BGM over the specified duration.
 * @param {number} duration - Fade duration in seconds
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function fadeBGM(duration) {
  duration = duration !== undefined ? duration : 1;
  return [
    { code: 242, indent: 0, parameters: [duration] }
  ];
}

/**
 * Wait — code 230
 * Pauses event execution for the specified number of frames (60 frames = 1 second).
 * @param {number} frames - Number of frames to wait
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function wait(frames) {
  return [
    { code: 230, indent: 0, parameters: [frames] }
  ];
}

/**
 * Label — code 118
 * Marks a position in the event command list for use with Jump to Label.
 * @param {string} name - Label name
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function label(name) {
  return [
    { code: 118, indent: 0, parameters: [name] }
  ];
}

/**
 * Jump to Label — code 119
 * Jumps execution to the specified label in the event command list.
 * @param {string} name - Label name to jump to
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function jumpToLabel(name) {
  return [
    { code: 119, indent: 0, parameters: [name] }
  ];
}

/**
 * Erase Event — code 214
 * Erases the current event from the map until the map is reloaded.
 * Commonly used for one-time events that should disappear after triggering.
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function eraseEvent() {
  return [
    { code: 214, indent: 0, parameters: [] }
  ];
}

/**
 * Game Over — code 353
 * Triggers an immediate game over screen.
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function gameOver() {
  return [
    { code: 353, indent: 0, parameters: [] }
  ];
}

/**
 * Show Picture — code 231
 * Displays a picture on the screen at the specified position.
 * @param {number} id - Picture ID (1-100)
 * @param {string} name - Picture filename (from img/pictures/)
 * @param {number} x - X position
 * @param {number} y - Y position
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function showPicture(id, name, x, y) {
  return [
    { code: 231, indent: 0, parameters: [id, name, 0, 0, x, y, 100, 100, 255, 0] }
  ];
}

/**
 * Plugin Command — code 356
 * Executes a plugin command string.
 * @param {string} command - The plugin command string
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function pluginCommand(command) {
  return [
    { code: 356, indent: 0, parameters: [command] }
  ];
}

/**
 * Comment — code 108
 * Adds a comment line to the event command list.
 * @param {string} text - Comment text
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function comment(text) {
  return [
    { code: 108, indent: 0, parameters: [text] }
  ];
}

/**
 * End of Event Processing — code 0
 * Terminates event command processing. Every event page's list
 * must end with this command.
 * @returns {Array<{code:number, indent:number, parameters:any[]}>}
 */
function end() {
  return [
    { code: 0, indent: 0, parameters: [] }
  ];
}

function playSE(name, volume, pitch, pan) {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 250, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

function changePartyMember(actorId, add) {
  add = add !== undefined ? add : true;
  return [
    { code: 129, indent: 0, parameters: [actorId, add ? 0 : 1, 0] }
  ];
}

function changeHP(actorId, value, isAdd) {
  isAdd = isAdd !== undefined ? isAdd : true;
  return [
    { code: 311, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, false] }
  ];
}

function changeMP(actorId, value, isAdd) {
  isAdd = isAdd !== undefined ? isAdd : true;
  return [
    { code: 312, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value] }
  ];
}

function changeEXP(actorId, value, isAdd) {
  isAdd = isAdd !== undefined ? isAdd : true;
  return [
    { code: 315, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, false] }
  ];
}

function changeLevel(actorId, value, isAdd) {
  isAdd = isAdd !== undefined ? isAdd : true;
  return [
    { code: 317, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, false] }
  ];
}

function changeSkill(actorId, skillId, learn) {
  learn = learn !== undefined ? learn : true;
  return [
    { code: 318, indent: 0, parameters: [0, actorId, learn ? 0 : 1, skillId] }
  ];
}

function changeEquip(actorId, slotType, itemId) {
  return [
    { code: 319, indent: 0, parameters: [actorId, slotType, itemId] }
  ];
}

function scrollMap(direction, distance, speed) {
  return [
    { code: 204, indent: 0, parameters: [direction, distance, speed || 4] }
  ];
}

function battleProcessing(troopId, canEscape, canLose) {
  canEscape = canEscape !== undefined ? canEscape : true;
  canLose = canLose !== undefined ? canLose : false;
  return [
    { code: 301, indent: 0, parameters: [0, troopId, canEscape, canLose] }
  ];
}

function shopProcessing(goods, purchaseOnly) {
  purchaseOnly = purchaseOnly !== undefined ? purchaseOnly : true;
  var result = [
    { code: 302, indent: 0, parameters: [0, goods, purchaseOnly] }
  ];
  if (goods.length > 0) {
    result.push({ code: 605, indent: 0, parameters: goods[0] });
  }
  for (var i = 1; i < goods.length; i++) {
    result.push({ code: 605, indent: 0, parameters: goods[i] });
  }
  return result;
}

function nameInput(actorId, maxLength) {
  maxLength = maxLength || 8;
  return [
    { code: 303, indent: 0, parameters: [actorId, maxLength] }
  ];
}

function changeMapDisplayName(displayName) {
  return [
    { code: 323, indent: 0, parameters: [displayName] }
  ];
}

function setMoveRoute(eventId, routeCommands) {
  return [
    { code: 205, indent: 0, parameters: [eventId, { list: routeCommands, repeat: false, skippable: true, wait: true }] }
  ];
}

function moveRouteCommand(code, parameters) {
  return { code: code, parameters: parameters || [] };
}

function recoverAll(actorId) {
  return [
    { code: 314, indent: 0, parameters: [0, actorId] }
  ];
}

function changeActorName(actorId, name) {
  return [
    { code: 320, indent: 0, parameters: [actorId, name] }
  ];
}

function changeActorClass(actorId, classId) {
  return [
    { code: 321, indent: 0, parameters: [actorId, classId] }
  ];
}

function playBGS(name, volume, pitch, pan) {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 245, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

function fadeoutBGS(duration) {
  duration = duration !== undefined ? duration : 1;
  return [
    { code: 246, indent: 0, parameters: [duration] }
  ];
}

function playME(name, volume, pitch, pan) {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 249, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

function getActorInfo(actorId) {
  return [
    { code: 108, indent: 0, parameters: ['Get Actor Info placeholder - use script calls for advanced features'] }
  ];
}

const cmd = {
  message,
  choice,
  branchChoice,
  endChoices,
  conditionalSwitch,
  conditionalSelfSwitch,
  conditionalVariable,
  endConditional,
  switchControl,
  selfSwitchControl,
  variableControl,
  giveItem,
  giveWeapon,
  giveArmor,
  giveMoney,
  teleport,
  showAnimation,
  playBGM,
  fadeBGM,
  playSE,
  playBGS,
  fadeoutBGS,
  playME,
  wait,
  label,
  jumpToLabel,
  eraseEvent,
  gameOver,
  showPicture,
  pluginCommand,
  comment,
  changePartyMember,
  changeHP,
  changeMP,
  changeEXP,
  changeLevel,
  changeSkill,
  changeEquip,
  scrollMap,
  battleProcessing,
  shopProcessing,
  nameInput,
  changeMapDisplayName,
  setMoveRoute,
  moveRouteCommand,
  recoverAll,
  changeActorName,
  changeActorClass,
  end
};

module.exports = { cmd };

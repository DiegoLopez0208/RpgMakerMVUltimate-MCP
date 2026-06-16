/**
 * commandBuilder.ts — RPG Maker MV Event Command Builder
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

import type { EventCommand, SelfSwitchKey } from '../types/rpgmaker.js';

/**
 * Show Text — code 101 (header) + code 401 (text lines) + code 0 (terminator)
 * Displays a message box with the given text. If faceName is provided,
 * shows the specified face graphic.
 * @param text - The message text (can contain \n for multiple lines)
 * @param faceName - Face graphic filename (empty string for no face)
 * @param faceIndex - Face index in the graphic (0-7)
 * @returns EventCommand[]
 */
function message(text: string, faceName: string, faceIndex: number): EventCommand[] {
  faceName = faceName || '';
  faceIndex = faceIndex || 0;
  const lines = text.split('\n');
  const commands: EventCommand[] = [
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
 * @param options - Array of choice text strings
 * @param cancelType - Cancel behavior (0=disallowed, 1-6=branch index, -1=cancel branch)
 * @returns EventCommand[]
 */
function choice(options: string[], cancelType: number): EventCommand[] {
  cancelType = cancelType !== undefined ? cancelType : -1;
  return [
    { code: 102, indent: 0, parameters: [options, cancelType] }
  ];
}

/**
 * Branch Choice — code 402
 * Marks the start of a choice branch. Must appear inside a Show Choices block.
 * @param index - The choice index this branch handles
 * @param label - The choice text label
 * @returns EventCommand[]
 */
function branchChoice(index: number, label: string): EventCommand[] {
  return [
    { code: 402, indent: 0, parameters: [index, label] }
  ];
}

/**
 * End Choices — code 404
 * Marks the end of a Show Choices block.
 * @returns EventCommand[]
 */
function endChoices(): EventCommand[] {
  return [
    { code: 404, indent: 0, parameters: [] }
  ];
}

/**
 * Conditional Branch: Switch — code 111, type 0
 * Checks if a game switch is ON or OFF. Commands inside the branch
 * have indent+1. Follow with endConditional (code 412).
 * @param switchId - The switch ID to check
 * @param value - true = ON, false = OFF
 * @returns EventCommand[]
 */
function conditionalSwitch(switchId: number, value: boolean): EventCommand[] {
  value = value !== undefined ? value : true;
  return [
    { code: 111, indent: 0, parameters: [0, switchId, value ? 0 : 1] }
  ];
}

/**
 * Conditional Branch: Self Switch — code 111, type 2
 * Checks if a self switch (A/B/C/D) is ON or OFF.
 * @param key - Self switch key: "A", "B", "C", or "D"
 * @param value - true = ON, false = OFF
 * @returns EventCommand[]
 */
function conditionalSelfSwitch(key: SelfSwitchKey, value: boolean): EventCommand[] {
  value = value !== undefined ? value : true;
  return [
    { code: 111, indent: 0, parameters: [2, key, value ? 0 : 1] }
  ];
}

/**
 * Conditional Branch: Variable — code 111, type 1
 * Checks a game variable against a value using an operator.
 * @param varId - The variable ID to check
 * @param operator - Comparison: 0=eq, 1=ge, 2=le, 3=gt, 4=lt, 5=ne
 * @param val - The value to compare against
 * @returns EventCommand[]
 */
function conditionalVariable(varId: number, operator: number, val: number): EventCommand[] {
    // MV command 111 type 1 (variable): [1, varId, operandType, operandValue,
    // comparisonOp]. operandType 0 = compare against a constant. The params
    // were previously [1, varId, operator, 0, val], which made MV compare the
    // variable against variable #0 and use `val` as the operator.
    return [
        { code: 111, indent: 0, parameters: [1, varId, 0, val, operator] }
    ];
}

/**
 * End Conditional — code 412
 * Marks the end of a Conditional Branch block.
 * @returns EventCommand[]
 */
function endConditional(): EventCommand[] {
  return [
    { code: 412, indent: 0, parameters: [] }
  ];
}

/**
 * Control Switches — code 121
 * Turns a game switch ON or OFF.
 * @param id - The switch ID to control
 * @param value - true = ON (0), false = OFF (1)
 * @returns EventCommand[]
 */
function switchControl(id: number, value: boolean): EventCommand[] {
  value = value !== undefined ? value : true;
  return [
    { code: 121, indent: 0, parameters: [id, id, value ? 0 : 1] }
  ];
}

/**
 * Control Self Switch — code 123
 * Turns a self switch (A/B/C/D) ON or OFF for the current event.
 * @param key - Self switch key: "A", "B", "C", or "D"
 * @param value - true = ON (0), false = OFF (1)
 * @returns EventCommand[]
 */
function selfSwitchControl(key: SelfSwitchKey, value: boolean): EventCommand[] {
  value = value !== undefined ? value : true;
  return [
    { code: 123, indent: 0, parameters: [key, value ? 0 : 1] }
  ];
}

/**
 * Control Variables — code 122
 * Performs an operation on a game variable.
 * @param id - The variable ID
 * @param opType - Operation: 0=set, 1=add, 2=sub, 3=mul, 4=div, 5=mod
 * @param val - The operand value (used with operand type 0 = constant)
 * @returns EventCommand[]
 */
function variableControl(id: number, opType: number, val: number): EventCommand[] {
  return [
    { code: 122, indent: 0, parameters: [id, id, opType, 0, val] }
  ];
}

/**
 * Change Items — code 126
 * Adds or removes an item from the party inventory.
 * @param itemId - The item ID
 * @param amount - Quantity (positive = add)
 * @returns EventCommand[]
 */
function giveItem(itemId: number, amount: number): EventCommand[] {
  amount = amount || 1;
  return [
    { code: 126, indent: 0, parameters: [itemId, 0, 0, amount] }
  ];
}

/**
 * Change Weapons — code 127
 * Adds or removes a weapon from the party inventory.
 * @param weaponId - The weapon ID
 * @param amount - Quantity to add
 * @returns EventCommand[]
 */
function giveWeapon(weaponId: number, amount: number): EventCommand[] {
  amount = amount || 1;
  return [
    { code: 127, indent: 0, parameters: [weaponId, 0, 0, amount] }
  ];
}

/**
 * Change Armors — code 128
 * Adds or removes an armor from the party inventory.
 * @param armorId - The armor ID
 * @param amount - Quantity to add
 * @returns EventCommand[]
 */
function giveArmor(armorId: number, amount: number): EventCommand[] {
  amount = amount || 1;
  return [
    { code: 128, indent: 0, parameters: [armorId, 0, 0, amount] }
  ];
}

/**
 * Change Gold — code 125
 * Adds or subtracts gold from the party.
 * @param amount - Amount of gold (positive to add)
 * @returns EventCommand[]
 */
function giveMoney(amount: number): EventCommand[] {
  return [
    { code: 125, indent: 0, parameters: [0, 0, amount] }
  ];
}

/**
 * Transfer Player — code 201
 * Teleports the player to a new map position.
 * @param mapId - Destination map ID
 * @param x - Destination X coordinate
 * @param y - Destination Y coordinate
 * @param direction - Direction after transfer (0=retain, 2=down, 4=left, 6=right, 8=up)
 * @param fadeType - Fade type (0=black, 1=white, 2=none)
 * @returns EventCommand[]
 */
function teleport(mapId: number, x: number, y: number, direction: number, fadeType: number): EventCommand[] {
  direction = direction || 0;
  fadeType = fadeType || 0;
  return [
    { code: 201, indent: 0, parameters: [0, mapId, x, y, direction, fadeType] }
  ];
}

/**
 * Show Animation — code 212
 * Plays an animation on a character or event.
 * @param eventId - Event ID (0 = player, -1 = this event)
 * @param animId - Animation ID from the database
 * @returns EventCommand[]
 */
function showAnimation(eventId: number, animId: number): EventCommand[] {
  return [
    { code: 212, indent: 0, parameters: [eventId, animId] }
  ];
}

/**
 * Play BGM — code 241
 * Plays a background music track.
 * @param name - BGM filename
 * @param volume - Volume (0-100)
 * @param pitch - Pitch (50-200)
 * @param pan - Pan (-100 to 100)
 * @returns EventCommand[]
 */
function playBGM(name: string, volume: number, pitch: number, pan: number): EventCommand[] {
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
 * @param duration - Fade duration in seconds
 * @returns EventCommand[]
 */
function fadeBGM(duration: number): EventCommand[] {
  duration = duration !== undefined ? duration : 1;
  return [
    { code: 242, indent: 0, parameters: [duration] }
  ];
}

/**
 * Wait — code 230
 * Pauses event execution for the specified number of frames (60 frames = 1 second).
 * @param frames - Number of frames to wait
 * @returns EventCommand[]
 */
function wait(frames: number): EventCommand[] {
  return [
    { code: 230, indent: 0, parameters: [frames] }
  ];
}

/**
 * Label — code 118
 * Marks a position in the event command list for use with Jump to Label.
 * @param name - Label name
 * @returns EventCommand[]
 */
function label(name: string): EventCommand[] {
  return [
    { code: 118, indent: 0, parameters: [name] }
  ];
}

/**
 * Jump to Label — code 119
 * Jumps execution to the specified label in the event command list.
 * @param name - Label name to jump to
 * @returns EventCommand[]
 */
function jumpToLabel(name: string): EventCommand[] {
  return [
    { code: 119, indent: 0, parameters: [name] }
  ];
}

/**
 * Erase Event — code 214
 * Erases the current event from the map until the map is reloaded.
 * Commonly used for one-time events that should disappear after triggering.
 * @returns EventCommand[]
 */
function eraseEvent(): EventCommand[] {
  return [
    { code: 214, indent: 0, parameters: [] }
  ];
}

/**
 * Game Over — code 353
 * Triggers an immediate game over screen.
 * @returns EventCommand[]
 */
function gameOver(): EventCommand[] {
  return [
    { code: 353, indent: 0, parameters: [] }
  ];
}

/**
 * Show Picture — code 231
 * Displays a picture on the screen at the specified position.
 * @param id - Picture ID (1-100)
 * @param name - Picture filename (from img/pictures/)
 * @param x - X position
 * @param y - Y position
 * @returns EventCommand[]
 */
function showPicture(id: number, name: string, x: number, y: number): EventCommand[] {
  return [
    { code: 231, indent: 0, parameters: [id, name, 0, 0, x, y, 100, 100, 255, 0] }
  ];
}

/**
 * Plugin Command — code 356
 * Executes a plugin command string.
 * @param command - The plugin command string
 * @returns EventCommand[]
 */
function pluginCommand(command: string): EventCommand[] {
  return [
    { code: 356, indent: 0, parameters: [command] }
  ];
}

/**
 * Comment — code 108
 * Adds a comment line to the event command list.
 * @param text - Comment text
 * @returns EventCommand[]
 */
function comment(text: string): EventCommand[] {
  return [
    { code: 108, indent: 0, parameters: [text] }
  ];
}

/**
 * End of Event Processing — code 0
 * Terminates event command processing. Every event page's list
 * must end with this command.
 * @returns EventCommand[]
 */
function end(): EventCommand[] {
  return [
    { code: 0, indent: 0, parameters: [] }
  ];
}

/**
 * Play SE — code 250
 * Plays a sound effect.
 * @param name - SE filename
 * @param volume - Volume (0-100)
 * @param pitch - Pitch (50-200)
 * @param pan - Pan (-100 to 100)
 * @returns EventCommand[]
 */
function playSE(name: string, volume: number, pitch: number, pan: number): EventCommand[] {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 250, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

/**
 * Change Party Member — code 129
 * Adds or removes an actor from the party.
 * @param actorId - The actor ID
 * @param add - true = add to party, false = remove from party
 * @returns EventCommand[]
 */
function changePartyMember(actorId: number, add: boolean): EventCommand[] {
  add = add !== undefined ? add : true;
  return [
    { code: 129, indent: 0, parameters: [actorId, add ? 0 : 1, 0] }
  ];
}

/**
 * Change HP — code 311
 * Modifies an actor's HP by a fixed value or percentage.
 * @param actorId - The actor ID (0 for entire party)
 * @param value - The amount to change
 * @param isAdd - true = add (0), false = subtract (1)
 * @returns EventCommand[]
 */
function changeHP(actorId: number, value: number, isAdd: boolean): EventCommand[] {
    isAdd = isAdd !== undefined ? isAdd : true;
    return [
        { code: 311, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, 0] }
    ];
}

/**
 * Change MP — code 312
 * Modifies an actor's MP by a fixed value or percentage.
 * @param actorId - The actor ID (0 for entire party)
 * @param value - The amount to change
 * @param isAdd - true = add (0), false = subtract (1)
 * @returns EventCommand[]
 */
function changeMP(actorId: number, value: number, isAdd: boolean): EventCommand[] {
  isAdd = isAdd !== undefined ? isAdd : true;
  return [
    { code: 312, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value] }
  ];
}

/**
 * Change EXP — code 315
 * Modifies an actor's experience points.
 * @param actorId - The actor ID (0 for entire party)
 * @param value - The amount to change
 * @param isAdd - true = add (0), false = subtract (1)
 * @returns EventCommand[]
 */
function changeEXP(actorId: number, value: number, isAdd: boolean): EventCommand[] {
    isAdd = isAdd !== undefined ? isAdd : true;
    return [
        { code: 315, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, 0] }
    ];
}

/**
 * Change Level — code 316. (Code 317 is Change Parameter — using it here, as a
 * previous version did, would change a random stat instead of the level.)
 * @param actorId - The actor ID (0 for entire party)
 * @param value - The amount to change
 * @param isAdd - true = add (0), false = subtract (1)
 * @returns EventCommand[]
 */
function changeLevel(actorId: number, value: number, isAdd: boolean): EventCommand[] {
    isAdd = isAdd !== undefined ? isAdd : true;
    return [
        { code: 316, indent: 0, parameters: [0, actorId, isAdd ? 0 : 1, 0, value, 0] }
    ];
}

/**
 * Change Skill — code 318
 * Teaches or forgets a skill for an actor.
 * @param actorId - The actor ID (0 for entire party)
 * @param skillId - The skill ID
 * @param learn - true = learn (0), false = forget (1)
 * @returns EventCommand[]
 */
function changeSkill(actorId: number, skillId: number, learn: boolean): EventCommand[] {
    learn = learn !== undefined ? learn : true;
    return [
        { code: 318, indent: 0, parameters: [0, actorId, learn ? 0 : 1, skillId] }
    ];
}

/**
 * Change State — code 313
 * Adds or removes a state from an actor.
 * @param actorId - The actor ID (0 for entire party)
 * @param stateId - The state ID
 * @param add - true = add (0), false = remove (1)
 * @returns EventCommand[]
 */
function changeState(actorId: number, stateId: number, add: boolean): EventCommand[] {
    add = add !== undefined ? add : true;
    return [
        { code: 313, indent: 0, parameters: [0, actorId, add ? 0 : 1, stateId] }
    ];
}

/**
 * Change Equip — code 319
 * Changes an actor's equipped item.
 * @param actorId - The actor ID
 * @param slotType - The equipment slot type
 * @param itemId - The item ID to equip (0 = unequip)
 * @returns EventCommand[]
 */
function changeEquip(actorId: number, slotType: number, itemId: number): EventCommand[] {
  return [
    { code: 319, indent: 0, parameters: [actorId, slotType, itemId] }
  ];
}

/**
 * Scroll Map — code 204
 * Scrolls the map camera in the specified direction.
 * @param direction - Direction to scroll (2=down, 4=left, 6=right, 8=up)
 * @param distance - Distance in tiles
 * @param speed - Scroll speed (default 4)
 * @returns EventCommand[]
 */
function scrollMap(direction: number, distance: number, speed: number): EventCommand[] {
  return [
    { code: 204, indent: 0, parameters: [direction, distance, speed || 4] }
  ];
}

/**
 * Battle Processing — code 301
 * Initiates a battle with a specific troop.
 * @param troopId - The troop ID to battle
 * @param canEscape - Whether escape is allowed
 * @param canLose - Whether losing continues the game
 * @returns EventCommand[]
 */
function battleProcessing(troopId: number, canEscape: boolean, canLose: boolean): EventCommand[] {
    canEscape = canEscape !== undefined ? canEscape : true;
    canLose = canLose !== undefined ? canLose : false;
    return [
        { code: 301, indent: 0, parameters: [0, troopId, canEscape ? 1 : 0, canLose ? 1 : 0] }
    ];
}

/**
 * Shop Processing — code 302
 * Opens a shop with the specified goods.
 * @param goods - Array of goods [itemType, itemId, priceFlag, price]
 * @param purchaseOnly - true = purchase only, false = buy and sell
 * @returns EventCommand[]
 */
function shopProcessing(goods: [number, number, number, number][], purchaseOnly: boolean): EventCommand[] {
    purchaseOnly = purchaseOnly !== undefined ? purchaseOnly : true;
    const result: EventCommand[] = [
        { code: 302, indent: 0, parameters: [0, purchaseOnly ? 1 : 0] }
    ];
    for (let i = 0; i < goods.length; i++) {
        result.push({ code: 605, indent: 0, parameters: goods[i] as unknown[] });
    }
    return result;
}

/**
 * Name Input — code 303
 * Opens the name input screen for an actor.
 * @param actorId - The actor ID
 * @param maxLength - Maximum character length
 * @returns EventCommand[]
 */
function nameInput(actorId: number, maxLength: number): EventCommand[] {
  maxLength = maxLength || 8;
  return [
    { code: 303, indent: 0, parameters: [actorId, maxLength] }
  ];
}

/**
 * Change Map Display Name — code 323
 * Changes the map name displayed on the save/load screen.
 * @param displayName - The new display name
 * @returns EventCommand[]
 */
function changeMapDisplayName(displayName: string): EventCommand[] {
  return [
    { code: 323, indent: 0, parameters: [displayName] }
  ];
}

/**
 * Set Move Route — code 205
 * Assigns a movement route to an event or the player.
 * @param eventId - Event ID (-1 = player, 0 = this event, >0 = specific event)
 * @param routeCommands - Array of move route commands
 * @returns EventCommand[]
 */
function setMoveRoute(eventId: number, routeCommands: EventCommand[]): EventCommand[] {
  return [
    { code: 205, indent: 0, parameters: [eventId, { list: routeCommands, repeat: false, skippable: true, wait: true }] }
  ];
}

/**
 * Move Route Command — helper for building individual move route commands.
 * @param code - The move route command code
 * @param parameters - The command parameters
 * @returns EventCommand
 */
function moveRouteCommand(code: number, parameters: unknown[]): EventCommand {
  return { code: code, indent: 0, parameters: parameters || [] };
}

/**
 * Recover All — code 314
 * Fully recovers an actor's HP, MP, and removes all states.
 * @param actorId - The actor ID (0 for entire party)
 * @returns EventCommand[]
 */
function recoverAll(actorId: number): EventCommand[] {
  return [
    { code: 314, indent: 0, parameters: [0, actorId] }
  ];
}

/**
 * Change Actor Name — code 320
 * Changes an actor's display name.
 * @param actorId - The actor ID
 * @param name - The new name
 * @returns EventCommand[]
 */
function changeActorName(actorId: number, name: string): EventCommand[] {
  return [
    { code: 320, indent: 0, parameters: [actorId, name] }
  ];
}

/**
 * Change Actor Class — code 321
 * Changes an actor's class.
 * @param actorId - The actor ID
 * @param classId - The new class ID
 * @returns EventCommand[]
 */
function changeActorClass(actorId: number, classId: number): EventCommand[] {
  return [
    { code: 321, indent: 0, parameters: [actorId, classId] }
  ];
}

/**
 * Play BGS — code 245
 * Plays a background sound.
 * @param name - BGS filename
 * @param volume - Volume (0-100)
 * @param pitch - Pitch (50-200)
 * @param pan - Pan (-100 to 100)
 * @returns EventCommand[]
 */
function playBGS(name: string, volume: number, pitch: number, pan: number): EventCommand[] {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 245, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

/**
 * Fadeout BGS — code 246
 * Fades out the currently playing BGS over the specified duration.
 * @param duration - Fade duration in seconds
 * @returns EventCommand[]
 */
function fadeoutBGS(duration: number): EventCommand[] {
  duration = duration !== undefined ? duration : 1;
  return [
    { code: 246, indent: 0, parameters: [duration] }
  ];
}

/**
 * Play ME — code 249
 * Plays a music effect (ME).
 * @param name - ME filename
 * @param volume - Volume (0-100)
 * @param pitch - Pitch (50-200)
 * @param pan - Pan (-100 to 100)
 * @returns EventCommand[]
 */
function playME(name: string, volume: number, pitch: number, pan: number): EventCommand[] {
  volume = volume !== undefined ? volume : 90;
  pitch = pitch !== undefined ? pitch : 100;
  pan = pan || 0;
  return [
    { code: 249, indent: 0, parameters: [{ name: name, pan: pan, pitch: pitch, volume: volume }] }
  ];
}

/**
 * Get Actor Info — code 108 (comment placeholder)
 * Provides actor information via a script call placeholder.
 * @param actorId - The actor ID
 * @returns EventCommand[]
 */
function getActorInfo(actorId: number): EventCommand[] {
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
  changeState,
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

export { cmd };

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const integer = { type: ['integer', 'string'] };
const command = {
  type: 'object', additionalProperties: false,
  properties: { code: { type: 'integer', minimum: 0 }, indent: { type: 'integer', minimum: 0 }, parameters: { type: 'array', items: {} } },
  required: ['code', 'indent', 'parameters']
};
const commands = { type: 'array', items: command };

/** Shared by default and legacy listings so their contracts cannot drift. */
export const EVENT_COMMAND_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'build_event_commands',
    description: 'Build a validated RPG Maker MV event-command fragment without writing files or requiring a selected project. Returns {commands, warnings?}; feed commands to insert_event_commands, or nest them in a choice/conditional builder. kind selects the command; only fields belonging to that kind are accepted. Troop-only kinds: enemy_appear, change_enemy_state, abort_battle. Fragments omit the root end marker; complete branches include their required nested end markers. MV Show Text has four parameters (no MZ speakerName); plugin_command emits MV code 356, never MZ 357. IDs accept integers or whole decimal integer strings; constants accept finite numbers. Supported game references are checked when inserting into a project.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['show_text', 'show_choices', 'conditional_branch', 'control_switch', 'control_variable', 'transfer_player', 'common_event', 'flow', 'plugin_command', 'change_gold', 'change_items', 'change_party_member', 'change_actor', 'play_audio', 'screen_effect', 'show_picture', 'erase_picture', 'show_animation', 'show_balloon', 'battle_processing', 'shop_processing', 'name_input', 'enemy_appear', 'change_enemy_state', 'abort_battle', 'move_route'] },
        indent: { ...integer, description: 'Base indentation, default 0. Nested branch bodies are rebased without mutating their inputs.' },
        lines: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'show_text: message lines. MV does not wrap; long lines are warned about unless wrap is set.' },
        wrap: { type: ['boolean', 'string'], enum: [true, false, 'hard'], description: 'show_text: true reflows all lines as one paragraph, "hard" keeps each line as a break; both split into 4-line boxes. Width ~55 chars, ~38 with a face.' },
        wrapWidth: { ...integer, description: 'show_text: override the wrap width in characters.' },
        faceName: { type: 'string', description: 'show_text: face image basename, default empty.' },
        faceIndex: { ...integer, description: 'show_text: face slot 0-7, default 0.' },
        background: { type: 'string', enum: ['window', 'dim', 'transparent'], description: 'Text/choice window background.' },
        position: { type: 'string', enum: ['top', 'middle', 'bottom', 'left', 'right'], description: 'show_text: top/middle/bottom; show_choices: left/middle/right.' },
        choices: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
        branches: { type: 'array', items: commands, description: 'show_choices: one command fragment per choice. Omit for empty branches.' },
        cancelBranch: { ...commands, description: 'show_choices: commands for a separate cancel branch.' },
        cancelType: { ...integer, description: 'show_choices: -1 disables cancel; -2 or choices.length selects the separate cancel branch; otherwise a zero-based choice index.' },
        defaultType: { ...integer, description: 'show_choices: selected choice index, or -1 for none.' },
        condition: {
          type: 'object', additionalProperties: false,
          description: 'conditional_branch: switch {type,switchId,value?}; self_switch {type,name,value?}; variable {type,variableId,comparison,constant? OR variableOperand?}; actor_in_party {type,actorId}; gold {type,gold,compare?}; item {type,itemId}. Only keys for the selected type are allowed.',
          properties: {
            type: { type: 'string', enum: ['switch', 'self_switch', 'variable', 'actor_in_party', 'gold', 'item'] },
            switchId: integer, name: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
            value: { type: 'string', enum: ['on', 'off'] }, variableId: integer,
            comparison: { type: 'string', enum: ['==', '>=', '<=', '>', '<', '!='] },
            constant: { type: ['number', 'string'] }, variableOperand: integer,
            actorId: integer, gold: { type: ['number', 'string'] },
            compare: { type: 'string', enum: ['>=', '<=', '<'] }, itemId: integer
          }, required: ['type']
        },
        thenBranch: commands,
        elseBranch: commands,
        scope: { type: 'string', enum: ['switch', 'self_switch'], description: 'control_switch: switch requires switchId; self_switch requires name A-D.' },
        switchId: integer,
        endId: { ...integer, description: 'control_switch/control_variable: inclusive final ID; defaults to the starting ID.' },
        name: { type: 'string', description: 'control_switch self_switch: A-D; flow label/jump_to_label: label text; play_audio: file name without extension (empty stops the channel); show_picture: picture file.' },
        value: { type: 'string', enum: ['on', 'off'], description: 'control_switch: default on.' },
        variableId: integer,
        operation: { type: 'string', enum: ['set', 'add', 'sub', 'mul', 'div', 'mod'] },
        operand: {
          type: 'object', description: 'control_variable: {type:"constant",value}; {type:"variable",variableId}; {type:"random",min,max}; or {type:"game_data",dataType:0..7,param1?,param2?}. MZ game-data type 8 is rejected.',
          properties: { type: { type: 'string', enum: ['constant', 'variable', 'random', 'game_data'] }, value: { type: ['number', 'string'] }, variableId: integer, min: integer, max: integer, dataType: integer, param1: integer, param2: integer }, required: ['type'], additionalProperties: false
        },
        designation: { type: 'string', enum: ['direct', 'variable'], description: 'transfer_player/show_picture: whether the coordinates are literal values or variable IDs.' },
        mapId: integer,
        x: integer,
        y: integer,
        direction: { type: 'string', enum: ['retain', 'down', 'left', 'right', 'up'] },
        fade: { type: 'string', enum: ['black', 'white', 'none'] },
        commonEventId: integer,
        action: { type: 'string', enum: ['wait', 'exit_event', 'label', 'jump_to_label'], description: 'flow: wait requires frames; label/jump_to_label require name.' },
        frames: integer,
        amount: { ...integer, description: 'change_gold/change_items/change_actor hp|mp|exp|level: constant amount. Give amount or amountVariableId.' },
        amountVariableId: { ...integer, description: 'Use this variable\'s value as the amount.' },
        decrease: { type: 'boolean', description: 'Subtract instead of add. Default false.' },
        itemType: { type: 'string', enum: ['item', 'weapon', 'armor'], description: 'change_items, default item.' },
        itemId: integer,
        includeEquip: { type: 'boolean', description: 'change_items weapon/armor: also remove equipped copies.' },
        actorId: { ...integer, description: 'change_party_member/name_input: actor ID. change_actor: actor ID, 0 = entire party (or use actorVariableId).' },
        actorVariableId: integer,
        remove: { type: 'boolean', description: 'change_party_member, change_actor state, change_enemy_state: remove instead of add.' },
        initialize: { type: 'boolean', description: 'change_party_member: reset the actor when adding.' },
        stat: { type: 'string', enum: ['hp', 'mp', 'exp', 'level', 'state', 'recover_all'], description: 'change_actor: hp takes allowDeath; exp/level take showLevelUp; state takes stateId and remove.' },
        stateId: integer,
        allowDeath: { type: 'boolean' },
        showLevelUp: { type: 'boolean' },
        channel: { type: 'string', enum: ['bgm', 'bgs', 'me', 'se'], description: 'play_audio.' },
        volume: integer, pitch: integer, pan: integer,
        effect: { type: 'string', enum: ['fadeout', 'fadein', 'tint', 'flash', 'shake'], description: 'screen_effect. tint: color [r,g,b,gray] -255..255; flash: color [r,g,b,strength] 0..255; shake: power, speed 1-9.' },
        color: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
        duration: { ...integer, description: 'screen_effect: frames, default 60.' },
        wait: { type: 'boolean', description: 'Wait for the effect, animation, balloon or move route to finish (move_route default true).' },
        power: integer, speed: integer,
        pictureId: { ...integer, description: 'show_picture/erase_picture: slot 1-100.' },
        origin: { type: 'string', enum: ['upper_left', 'center'] },
        scaleX: integer, scaleY: integer, opacity: integer,
        blend: { type: 'string', enum: ['normal', 'additive', 'multiply', 'screen'] },
        characterId: { ...integer, description: 'show_animation/show_balloon/move_route: -1 player, 0 this event (default), n map event n.' },
        animationId: integer,
        balloonId: { ...integer, description: '1-15 as in the editor list (1 exclamation).' },
        troopId: { ...integer, description: 'battle_processing: give troopId, troopVariableId, or randomEncounter: true.' },
        troopVariableId: integer,
        randomEncounter: { type: 'boolean' },
        canEscape: { type: 'boolean' },
        canLose: { type: 'boolean' },
        winBranch: { ...commands, description: 'battle_processing: result branches, only when canEscape or canLose.' },
        escapeBranch: commands,
        loseBranch: commands,
        goods: { type: 'array', minItems: 1, description: 'shop_processing: goods in order; omit price to use the database price.', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['item', 'weapon', 'armor'] }, id: integer, price: integer }, required: ['id'] } },
        purchaseOnly: { type: 'boolean' },
        maxLength: { ...integer, description: 'name_input: 1-16, default 8.' },
        steps: {
          type: 'array', minItems: 1, description: 'move_route: steps in order; times repeats one. toward/away are relative to the player. Parameters: jump x,y; wait frames; switch_on/off switchId; change_speed value 1-6; change_freq value 1-5; change_image name,index; change_opacity value 0-255; change_blend_mode value 0-3; play_se name,volume?,pitch?,pan?; script text.',
          items: { type: 'object', additionalProperties: false, required: ['step'], properties: {
            step: { type: 'string', enum: ['move_down', 'move_left', 'move_right', 'move_up', 'move_lower_l', 'move_lower_r', 'move_upper_l', 'move_upper_r', 'move_random', 'move_toward', 'move_away', 'move_forward', 'move_backward', 'jump', 'wait', 'turn_down', 'turn_left', 'turn_right', 'turn_up', 'turn_90d_r', 'turn_90d_l', 'turn_180d', 'turn_90d_r_l', 'turn_random', 'turn_toward', 'turn_away', 'switch_on', 'switch_off', 'change_speed', 'change_freq', 'walk_anime_on', 'walk_anime_off', 'step_anime_on', 'step_anime_off', 'dir_fix_on', 'dir_fix_off', 'through_on', 'through_off', 'transparent_on', 'transparent_off', 'change_image', 'change_opacity', 'change_blend_mode', 'play_se', 'script'] }, times: integer, x: integer, y: integer, frames: integer, switchId: integer,
            value: integer, name: { type: 'string' }, index: integer, volume: integer, pitch: integer, pan: integer, text: { type: 'string' } } }
        },
        repeat: { type: 'boolean', description: 'move_route: loop the route. Default false.' },
        skippable: { type: 'boolean', description: 'move_route: skip a step that cannot be performed. Default false.' },
        enemyIndex: { ...integer, description: 'Troop slot from 0; change_enemy_state also accepts -1 for the entire troop.' },
        text: { type: 'string', description: 'plugin_command: full MV command string, e.g. "DoorCtl open 1".' }
      },
      required: ['kind']
    }
  },
  {
    name: 'insert_event_commands',
    description: 'Insert a complete event-command fragment into a map event page, common event, or troop battle page. Validates the fragment, insertion boundary, resulting list, and supported references before writing. Invalid data refuses the write. Omit position to append before the root end marker; an explicit position must be a safe command boundary (not inside a text continuation or between a block header and its branches). Fragments are rebased to the target indentation. dryRun:true validates and previews without writing or creating backups. Normal writes use the existing atomic backup-protected project writer. Returns target identity, insertion count, the resulting list length and its command codes (listCodes), and warnings; pass verbose:true to also get the full before/after lists. Existing unknown extension commands are advisory; known MZ-only commands are rejected.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['map_event', 'common_event', 'troop_page'], description: 'Defaults to map_event.' },
        mapId: { ...integer, description: 'map_event target map ID.' },
        eventId: { ...integer, description: 'map_event target event ID.' },
        pageIndex: { ...integer, description: 'map_event/troop_page: zero-based page, default 0.' },
        commonEventId: { ...integer, description: 'common_event target ID.' },
        troopId: { ...integer, description: 'troop_page target troop ID.' },
        commands: { ...commands, minItems: 1, description: 'A complete fragment, typically returned by build_event_commands. A supplied final root terminator is normalized; the target always retains exactly one.' },
        position: { ...integer, description: 'Zero-based insertion index in the existing command list. Out-of-range or unsafe boundaries are rejected.' },
        dryRun: { type: 'boolean', description: 'Preview the validated change without writing. Default false.' },
        verbose: { type: 'boolean', description: 'Include the full before/after command lists in the result. Default false.' }
      },
      required: ['commands']
    }
  }
];

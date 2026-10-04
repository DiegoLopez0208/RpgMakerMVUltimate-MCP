# Building and inserting MV event commands

`build_event_commands` creates a command fragment in memory. It does not write
files or need a selected project. `insert_event_commands` validates and places
that fragment into an existing map-event page, common event, or troop page.
Both are available on the default and optional legacy tool surfaces.

## Builder kinds

All kinds accept an optional nonnegative `indent` (default `0`). Only fields
belonging to the selected kind are accepted. IDs accept integers or whole decimal
integer strings; numeric constants may be fractional finite numbers.

| `kind` | Required fields | Useful optional fields |
| --- | --- | --- |
| `show_text` | `lines: string[]` | `faceName`, `faceIndex`, `background`, `position`, `wrap: true / "hard"`, `wrapWidth` |
| `show_choices` | `choices: string[]` | `branches`, `cancelBranch`, `cancelType`, `defaultType`, `background`, `position` |
| `conditional_branch` | `condition` | `thenBranch`, `elseBranch` |
| `control_switch` | `scope: "switch"`, `switchId`; or `scope: "self_switch"`, `name: "A".."D"` | `value: "on" / "off"`, `endId` for a switch range |
| `control_variable` | `variableId`, `operand` | `endId`, `operation: set/add/sub/mul/div/mod` |
| `transfer_player` | `mapId`, `x`, `y` | `designation: direct/variable`, `direction`, `fade` |
| `common_event` | `commonEventId` | — |
| `flow` | `action: wait/exit_event/label/jump_to_label` | `frames` for wait; `name` for label/jump |
| `plugin_command` | `text` | — |
| `change_gold` | `amount` or `amountVariableId` | `decrease` |
| `change_items` | `itemId`, `amount` or `amountVariableId` | `itemType: item/weapon/armor`, `decrease`, `includeEquip` (weapon/armor) |
| `change_party_member` | `actorId` | `remove`, `initialize` |
| `change_actor` | `stat`, `actorId` (0 = entire party) or `actorVariableId` | per stat: `amount`/`amountVariableId`/`decrease` (hp, mp, exp, level), `allowDeath` (hp), `showLevelUp` (exp, level), `stateId`/`remove` (state); `recover_all` takes nothing else |
| `play_audio` | `channel: bgm/bgs/me/se`, `name` | `volume`, `pitch`, `pan` |
| `screen_effect` | `effect: fadeout/fadein/tint/flash/shake` | `color` (tint, flash), `duration`, `wait`, `power`/`speed` (shake) |
| `show_picture` | `pictureId`, `name` | `origin`, `designation`, `x`, `y`, `scaleX`, `scaleY`, `opacity`, `blend` |
| `erase_picture` | `pictureId` | — |
| `show_animation` | `animationId` | `characterId` (-1 player, 0 this event), `wait` |
| `show_balloon` | `balloonId` | `characterId`, `wait` |
| `battle_processing` | `troopId`, `troopVariableId` or `randomEncounter: true` | `canEscape`, `canLose`, `winBranch`, `escapeBranch`, `loseBranch` |
| `shop_processing` | `goods: [{ type?, id, price? }]` | `purchaseOnly` |
| `name_input` | `actorId` | `maxLength` |
| `enemy_appear` | `enemyIndex` | — (troop pages) |
| `change_enemy_state` | `enemyIndex` (-1 = entire troop), `stateId` | `remove` (troop pages) |
| `abort_battle` | — | — (troop pages) |
| `move_route` | `steps: [{ step, times?, ... }]` | `characterId` (-1 player, 0 this event), `repeat`, `skippable`, `wait` (default true) |

Each response has `commands`, plus advisory `warnings` when applicable. Fragments
omit the final root end marker. Nested branches include their own end markers.
Use returned `commands` arrays as choice/conditional bodies; relative nesting is
preserved and input arrays are not modified.

Conditions use a `type`: `switch`, `self_switch`, `variable`, `actor_in_party`,
`gold`, or `item`. For example:

```json
{
  "kind": "conditional_branch",
  "condition": { "type": "variable", "variableId": 1, "comparison": ">=", "constant": 3 },
  "thenBranch": [{ "code": 121, "indent": 0, "parameters": [2, 2, 0] }]
}
```

Variable operands use `type: constant` with `value`, `type: variable` with
`variableId`, `type: random` with `min`/`max`, or `type: game_data` with MV's
`dataType` (`0..7`) and `param1`/`param2` selectors. Invalid selectors are refused.

## Move routes

Step names are the engine's `Game_Character.ROUTE_*` constants in lower case:
`move_down`, `move_toward` (toward the player), `turn_90d_r`, `dir_fix_on`, `through_on` and so on.
`times` repeats a step. Steps that take parameters: `jump` `x`,`y`; `wait` `frames`;
`switch_on`/`switch_off` `switchId`; `change_speed` `value` 1-6; `change_freq` `value` 1-5;
`change_image` `name`,`index`; `change_opacity` `value` 0-255; `change_blend_mode` `value` 0-3;
`play_se` `name` (+ `volume`, `pitch`, `pan`); `script` `text`.

The route is written twice, as the editor does: on the 205 row, which the engine runs, and
as one 505 row per step without the end marker, which the editor lists.

```json
{ "kind": "move_route", "characterId": 0, "repeat": true,
  "steps": [{ "step": "move_left", "times": 3 }, { "step": "wait", "frames": 30 }, { "step": "move_right", "times": 3 }] }
```

## Troop battle pages

A new battle-event page goes through `update_database_entry` with `entity: "troops"` and `addPage`:

```json
{ "entity": "troops", "id": 4, "addPage": {
  "when": { "enemyHpBelow": [0, 50] }, "span": "battle",
  "commands": [ ...from build_event_commands... ] } }
```

`when` checks are ANDed and at least one is required, because the engine never runs a page with
none: `turn: [a, b]` (turn a + b*X; b 0 means only turn a), `enemyHpBelow: [troop slot from 0, pct]`,
`actorHpBelow: [actorId, pct]`, `switchId`, `turnEnd: true`. `span` is `battle`, `turn` or `moment`;
`position` inserts before an existing page. Conditions that could never hold (an empty enemy slot, a
missing actor) and broken references in `commands` are refused.

## Compose choices, preview, then insert

First call `build_event_commands`:

```json
{
  "kind": "show_choices",
  "choices": ["Open the gate", "Leave"],
  "branches": [
    [{ "code": 121, "indent": 0, "parameters": [1, 1, 0] }],
    []
  ],
  "cancelType": 1
}
```

Pass the returned `commands` to `insert_event_commands` with:

```json
{
  "target": "map_event",
  "mapId": 1,
  "eventId": 2,
  "pageIndex": 0,
  "commands": [
    { "code": 102, "indent": 0, "parameters": [["Open the gate", "Leave"], 1, 0, 2, 0] },
    { "code": 402, "indent": 0, "parameters": [0, "Open the gate"] },
    { "code": 121, "indent": 1, "parameters": [1, 1, 0] },
    { "code": 0, "indent": 1, "parameters": [] },
    { "code": 402, "indent": 0, "parameters": [1, "Leave"] },
    { "code": 0, "indent": 1, "parameters": [] },
    { "code": 404, "indent": 0, "parameters": [] }
  ],
  "dryRun": true
}
```

The response includes the target filename, insertion position/count, the
resulting `listLength`, its command codes (`listCodes`), and warnings. Pass
`verbose: true` to also get the full `before` and `after` lists; they are left
out by default because a long event would echo thousands of tokens. A dry run performs the same validation as a commit without
writing files or creating backups. Repeat with `dryRun: false` to apply the change.

Other targets are `{target:"common_event", commonEventId:1}` and
`{target:"troop_page", troopId:1, pageIndex:0}`. `pageIndex` defaults to `0`.
The default position appends before the list's final root end marker. An explicit
`position` is an array index and must be a safe boundary: inserting between text
continuations or into structural branch delimiters is refused. A complete
fragment is rebased to the selected branch's indentation.

The complete resulting list is checked structurally; malformed existing lists
must be repaired before insertion. References introduced by
the new fragment are checked where statically resolvable; unrelated old stale
references are not repaired. Variable-based transfers and runtime-only values
cannot be resolved until the game runs. Unknown extension commands receive
advisories rather than being executed or silently claimed valid.

## MV compatibility

- Show Text uses four parameters. `speakerName` is an MZ feature and is rejected.
- MV plugin commands use code `356` and a single command string. MZ `357`/`657`
  commands are rejected; installed plugin behavior is not inferred from the string.
- A separate choice cancel branch uses `cancelType: -2` (the editor's count-based
  representation is accepted too). `-1` disables cancellation; a choice index
  routes cancellation to that choice.
- Game-data operand type `8` is MZ-only and is rejected.
- Long dialogue lines are not automatically wrapped by vanilla MV. `show_text` warns about
  lines over about 55 characters (38 with a face); `wrap: true` reflows them and splits
  the message into four-line boxes. The width is a character estimate for the stock font.
- Battle Processing has result branches only when `canEscape` or `canLose` is set, as in
  the editor. Shop Processing writes the first good on the 302 row itself, as the engine reads it.
- Self switches depend on the interpreter's event context.

## Verification

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:protocol
npm run test:mv-runtime -- --engine "/path/to/MV/project/js/rpg_objects.js"
npm run test:mv-effects -- --engine "/path/to/MV/project/js/rpg_objects.js"
```

The optional final command runs the real local MV interpreter in a Node VM with
scene/asset boundaries stubbed. It checks command execution, not GUI rendering or
third-party plugin behavior. The engine files stay local and are read-only.

`test:mv-effects` runs the party, presentation, scene, troop and move route builders through the same
interpreter with the game world replaced by spies, and checks the exact calls it makes
(for example `$gameParty.gainItem(weapon 2, -3, true)` or `SceneManager.prepareNextScene(goods, true)`),
so each parameter is proven to sit in the slot the engine reads. It also checks every move route step
against `Game_Character.ROUTE_*` and evaluates built troop pages with `Game_Troop.meetsConditions`.

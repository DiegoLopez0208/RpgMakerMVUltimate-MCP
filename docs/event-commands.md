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
| `show_text` | `lines: string[]` | `faceName`, `faceIndex`, `background`, `position` |
| `show_choices` | `choices: string[]` | `branches`, `cancelBranch`, `cancelType`, `defaultType`, `background`, `position` |
| `conditional_branch` | `condition` | `thenBranch`, `elseBranch` |
| `control_switch` | `scope: "switch"`, `switchId`; or `scope: "self_switch"`, `name: "A".."D"` | `value: "on" / "off"`, `endId` for a switch range |
| `control_variable` | `variableId`, `operand` | `endId`, `operation: set/add/sub/mul/div/mod` |
| `transfer_player` | `mapId`, `x`, `y` | `designation: direct/variable`, `direction`, `fade` |
| `common_event` | `commonEventId` | — |
| `flow` | `action: wait/exit_event/label/jump_to_label` | `frames` for wait; `name` for label/jump |
| `plugin_command` | `text` | — |

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
- Long dialogue lines are not automatically wrapped by vanilla MV.
- Self switches depend on the interpreter's event context.

## Verification

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:protocol
npm run test:mv-runtime -- --engine "/path/to/MV/project/js/rpg_objects.js"
```

The optional final command runs the real local MV interpreter in a Node VM with
scene/asset boundaries stubbed. It checks command execution, not GUI rendering or
third-party plugin behavior. The engine files stay local and are read-only.

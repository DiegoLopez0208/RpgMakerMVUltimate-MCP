# MV authoring and runtime parity

The default MCP discovery response exposes 96 tools: the existing 17 consolidated
tools plus 79 specialist operations. Existing consolidated and legacy argument
contracts remain available; `RPGMV_LEGACY_TOOLS=1` additionally advertises the
legacy names. Reconnect the MCP client after building or upgrading to refresh
discovery. This change does not publish a new npm version.

## Capabilities

| Area | Operations and behavior |
| --- | --- |
| Event commands | `build_*` helpers cover text, choices, branches, flow, switches, variables, gold, inventory, party, transfers, audio, screen/picture/character effects, battles, shops, name input, actors and enemies. Existing `build_event_commands` and `insert_event_commands` remain supported. |
| Event and battle pages | `set_event_page` edits only supplied fields. `create_move_route` and `set_movement_route` handle named/custom steps and 205/505 commands. `build_troop_page` and `add_troop_page` author battle conditions. |
| Tile catalogs | `get_tile_catalog`, `find_tile` and `describe_tile` resolve MV tiles, project sidecars and custom overlays. Built-in names require matching image fingerprints, not familiar filenames. Transparency inspection is included. |
| Painting | `paint_tiles`, `fill_area` and `paint_blueprint` recompute autotile shapes. `object_tiles` and `place_object` handle multi-tile objects. `get_tile_flags`, `set_tile_flags` and `check_passability` inspect or update selected flags and directional passage. |
| Map administration | `resize_map` preserves all six layers; `delete_map` checks references; `update_map_tree` validates parents and cycles; `update_map`, `set_encounters` and `get_map_region` support targeted edits and cropped reads. Consolidated `edit_map` also exposes its existing tile/rectangle actions. |
| Database administration | `batch_create`, `delete_record`, `reset_table`, `list_allocated_ids`, `next_free_id`, `add_class_learning`, `set_class_param_curve`, `update_weapon` and `update_armor` supplement existing CRUD. |
| System | Starting party, title graphics/music, terms, type names and currency have focused get/set tools. Existing starting-position and switch/variable naming operations remain available. |
| Validation and assets | `list_assets`, `list_names`, `get_database`, `validate_event`, `validate_project`, `validate_references`, and `validate_assets` support inspection and structural audits. New guarded writes validate their proposed data before committing. |
| Headless testing | `render_map` renders a complete map or viewport through the project's MV engine. `run_playtest` supports load/state setup, events, text, choices, walking, input, battles, screenshots and JavaScript inspection. |
| Web deployment | `export_web` creates a folder and optional ZIP, reports sizes, optionally prunes unused assets, and preserves MV encrypted asset bytes and encryption settings. |
| Plugins | `scan_plugins` and `list_plugin_commands` inspect annotations. `create_plugin_command` emits one raw MV command string. Legacy status/toggle now read and update `js/plugins.js`, preserving parameters. |
| Live bridge | Authenticated, project-bound, single-client sessions; protected installation; bounded messages/captures; completed transfers; cleanup on retarget/disconnect. Video and FPS/performance telemetry remain available. |
| Analysis | Strict formula grammar, common-event transfer traversal, troop outlines/refactors, relative-indent duplicate matching, compact huge-ID ranges, expanded lexical search and explicit zero-variance outliers. Static uncertainty is retained in results. |

See [event command documentation](event-commands.md) for the builder schemas and
MV runtime examples. All schemas are discoverable through MCP `tools/list`.

## Previewing and writing

Pass `dryRun:true` to a mutating tool to preview its supported changes. The
response includes `commits` with file paths, leaf differences, deletion markers
and a truncation flag after 200 differences. Legacy results also retain
`wouldWrite`; the existing `insert_event_commands` preview keeps its own
before/after format. Runtime previews do not launch games, install plugins,
start/stop a bridge, send commands or take captures. Export previews report the
planned output without creating it.

```json
{"name":"resize_map","arguments":{"mapId":1,"width":30,"height":22,"dryRun":true}}
{"name":"batch_create","arguments":{"type":"item","records":[{"name":"Potion","price":20}],"dryRun":true}}
{"name":"set_currency_unit","arguments":{"unit":"Gold","dryRun":true}}
```

Removing `dryRun` applies the operation. JSON writes use backups and atomic
replacement. Grouped text writes (plugin plus manifest) stage and validate all
files, detect intervening edits, and roll back ordinary failures. This is not a
database transaction against power loss, and the MV editor does not participate
in the server's request queue. Avoid simultaneously saving the same project file
from the editor and the MCP.

Only tools that actually implement an override expose `force`. It cannot make
MZ-only command data valid in MV. Legacy add-one-command workflows remain
incremental; use validated block builders and insertion for complete structures.
Static reference checks cannot prove the absence of uses inside arbitrary scripts
or plugin code. ID suggestions are advisory, not reservations; new switch or
variable IDs need slots in `System.json` before MV can store them.

## MV-specific adaptations

- Show Text uses four parameters. MV has no native MZ speaker-name box.
- Skill and item target scopes are integers 0–11: 7 targets one ally, 8 targets
  all allies, and 11 targets the user. MZ-only scopes 12–14 are rejected before
  single, batch or partial-update writes.
- Plugin commands use code 356 and exact text. Code 357/657 and MZ game-data
  operands are rejected even with `force`. Metadata does not determine positional
  arguments for a classic MV plugin.
- Animations use MV's animation database and sheets; MZ Effekseer assets are not
  converted by these tools.
- Default MV tiles are 48 pixels. Layers 0–3 hold tiles, layer 4 shadow bits and
  layer 5 region IDs. Plugins that change tile geometry need separate support.
- Custom catalog precedence is manual project labels, verified built-in/sidecar
  labels, then draft project labels. The
  [custom catalog workflow](../skill/mv-tileset-catalog/SKILL.md) creates indexed
  montages and metadata without bundling purchased artwork.
- Text width is an estimate unless the project supplies measured widths in
  `.rpgmaker-mcp.json`; wrapping preserves control sequences and message pages.

## Headless rendering and deployment

Headless tools require Node.js 20 or newer; other tools retain Node.js 18 support.
Install the optional `playwright-core` dependency and provide a compatible
Chromium executable through `RPGMAKER_MCP_CHROMIUM`, or install a cached Chromium
headless shell with `npx playwright install chromium-headless-shell`.
The server uses the project's licensed MV engine and assets; neither is bundled.

```json
{"name":"render_map","arguments":{"mapId":1,"inline":true}}
{"name":"run_playtest","arguments":{"steps":[{"action":"load","mapId":1,"x":5,"y":5},{"action":"startEvent","eventId":1},{"action":"advanceText"},{"action":"screenshot","name":"conversation"}],"inline":true}}
{"name":"export_web","arguments":{"outDir":"deployment-web","zip":true,"prune":false,"dryRun":true}}
```

Screenshots default to an OS temporary directory. `inline:true` adds native MCP
PNG blocks alongside JSON structured content.
Inline delivery is limited to eight images and 32 MiB in total; protocol
`_meta.imageDelivery` reports omissions while file paths remain in the result.
Long playtests send step progress
and heartbeat notifications when the client supplies a progress token; configure
a suitable request timeout. Whole-map renders normally freeze autorun/parallel
events and hide the player; viewport and event-running options are explicit.
Headless sessions isolate runtime state from the live NW.js game.

Export only replaces an existing nonempty directory marked as a prior export.
Use `prune:false` for plugins that construct asset names dynamically; static
scanning cannot identify every such dependency. Playtest the exported build.
Encryption preservation has fixture coverage; actual encrypted-game playback is
not part of the recorded acceptance run.

## Reproducing verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:protocol
npm run test:parity-protocol
npm run test:mv-authoring -- --engine "/licensed/MV/NewData/js/rpg_objects.js"
npm run test:mv-parity-runtime -- --project "/disposable/MV/project" --disposable-fixture yes
```

`test:mv-headless-protocol` reads `RPGMAKER_MCP_TEST_PROJECT` and
`RPGMAKER_MCP_CHROMIUM`. The runtime smoke must receive a disposable licensed
fixture: it installs the bridge and temporarily prepares test scenes, then
restores the scene/package files and removes its temporary shim. The bridge
installation remains in that disposable fixture. Its hidden NW.js timer shim belongs only to that
verification fixture; the production plugin does not alter game focus/render
scheduling. The authoring harness reads engine files without changing them.

Recorded local acceptance used MV core reporting 1.6.1, Chromium/Edge for
headless execution, and the installed MV NW.js runtime for live bridge checks.
It covered all 12 added builder families, movement routes, troop conditions,
dialogue choices, walking/state setup, accelerated battles, map/viewport PNGs,
native stdio images/progress, video recording, and a separately rendered web
export. Older MV/NW.js versions and every third-party plugin combination have
not been exercised. Structural tests and engine smoke results are separate
evidence, not a guarantee for arbitrary game logic.

# MV parity implementation contract

Source baseline: MV `f3d0dad`; MZ `c863b4d`. This is the complete scope approved on 2026-10-03. Existing MV consolidated tools, generation, analysis, recording, and older NW.js compatibility must remain available. Work is on `feat/mv-mz-parity`; game verification uses a disposable licensed MV fixture outside this repository.

## Completion requirements

- [x] Remaining event builders: gold, inventory, party, audio, screen effects, pictures, character effects, battle/shop/name input, actor and battle changes; wrapping and width warnings. MV parameter layouts only.
- [x] Partial event-page edits, named/custom movement routes, validated 205/505 insertion, troop page build/add.
- [x] MV/project-specific tile catalog discovery, named search, sidecars/overlays, provenance, decoding, transparency inspection.
- [x] Autotile-aware cell/rectangle/blueprint painting, multi-tile objects, selective tile flags and directional layered passability; expose existing hidden MV tile actions.
- [x] Six-layer map resizing, safe deletion, generic metadata, validated tree editing and region reads.
- [x] Batch database creation, reference-aware deletion/table reset, safe unused ID suggestions, targeted class helpers.
- [x] Starting party, title screen, terms, type names and currency setters.
- [x] Asset/audio inventory and reference audit; broader database and write-time validation; discoverable detailed dry-run diffs and protected grouped writes.
- [x] Real MV headless map rendering and scripted playtest scenarios; inline images and progress notifications.
- [x] MV web deployment folder/ZIP with dependency-aware pruning and size reporting.
- [x] Plugin metadata adapted to MV, and repair legacy status/toggle to use js/plugins.js.
- [x] Runtime hardening without losing video/performance telemetry: project authentication, handshake ownership, bounded buffers, safe installation/screenshots, completed transfers, retarget/EOF cleanup.
- [x] Analysis backports: strict formula parsing, common-event transfer traversal, troop outlines/duplicates, relative-indent matching, huge ID ranges, zero-variance outliers.
- [x] Documentation, MIT attribution, protocol regression checks, full test/build/lint and licensed engine verification.
- [x] GitHub delivery: upstream PR #20 from IXTLIA:feat/mv-mz-parity.

## Invariants

No engine files or purchased assets in Git. No writes to the user's game project. No MZ command 357/657 or fifth Show Text parameter in generated MV commands. MZ Effekseer and native name-box features require explicit MV equivalents rather than silent incompatible data. Dry runs may not start processes, mutate game state, modify files or install plugins. Static audits disclose limitations; runtime evidence is separate from structural validation. Native MCP structured content remains supported.

## Evidence log

Verified locally on 2026-10-03 with Node.js 22.18.0:

- Full suite: **1,245 tests across 86 files passed**, including the licensed MV tile fingerprint test (`MV_RTP_DIR` supplied); no skips.
- `npm run lint`, `npm run typecheck`, `npm run build` and `git diff --check` passed.
- Both stdio scripts passed in default and legacy modes: 96 and 195 unique advertised tools respectively, project-free builders, schema discovery, detailed previews without file/capture/bridge effects, commits and refusals.
- Real MV core reporting **1.6.1**: 14 retained interpreter scenarios and 15 added authoring scenarios passed. The authoring harness exercises real interpreter, party, actor, enemy, screen and character classes; scene/audio/render boundaries are stubbed.
- Real headless map (1008x720) and viewport rendering, dialogue and choice branches, walking/state setup, accelerated battles and screenshot capture passed. Native stdio PNGs (37,226 and 40,806 bytes) preserved structured content, with seven progress notifications including a heartbeat.
- Real authenticated NW.js bridge: new game, event state/commands, input, completed transfer, map/database reload, screenshot, FPS telemetry and a 329,666-byte WebM recording passed. Screenshot visually inspected. A fixture-only hidden-window timer shim was removed afterward; production code does not change focus/render scheduling.
- After cancellation hardening, a never-resolving headless evaluation stopped on stdin EOF in 229 ms. Only owned browser/server resources were closed; protected fixture files remained unchanged.
- Web export produced 565 files with 535 unused files pruned and a roughly 145.7 MB ZIP; the exported build rendered independently without reported errors. Encrypted asset preservation has synthetic fixture coverage, not encrypted-game playback acceptance.
- Packaging dry run: 544 entries, approximately 0.99 MB compressed and 7.28 MB unpacked. No engine JS, purchased PNG/audio, game projects, videos or environment files included. MIT attribution and the custom catalog helpers are packaged.
- All runtime work used a separate disposable licensed project. The user's game project and editor were not modified. Older MV/NW.js versions and arbitrary third-party plugin combinations remain outside this acceptance run. Headless tools require Node.js 20+; core tools retain Node.js 18 support.

Submitted as [upstream PR #20](https://github.com/DiegoLopez0208/RpgMakerMVUltimate-MCP/pull/20), from `IXTLIA:feat/mv-mz-parity`. Implementation commit: `ed947a87d65de728fa320bbb0749997a0e5b4c26`. It builds on still-open PR #19; upstream review/merge remains with the maintainer. Package version is unchanged so this work does not trigger an npm release.

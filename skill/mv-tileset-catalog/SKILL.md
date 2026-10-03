---
name: mv-tileset-catalog
description: Create semantic labels for custom RPG Maker MV tileset sheets that have no verified built-in catalog or text sidecar. Slice owned sheets into indexed samples, name visible tiles, and merge project metadata while preserving manual corrections.
---

# Custom MV tileset catalogs

Use this workflow when `get_tile_catalog` or `find_tile` reports missing names for a sheet. The MCP recognizes MV defaults by image fingerprint, not filename. A custom or MZ sheet reusing a default filename still needs its own metadata. Images are supplied by the user's project; do not redistribute them.

1. Read the target `Tilesets.json` entry. Slots are `[A1,A2,A3,A4,A5,B,C,D,E]`. Check for `img/tilesets/<Sheet>.txt` first: the MCP automatically loads its English names (`English|Japanese`, one local index per line; preserve blank lines).
2. For uncovered sheets run:
   ```sh
   node skill/mv-tileset-catalog/scripts/slice-tileset.mjs "<project>/img/tilesets/<Sheet>.png" "<workDir>" B
   ```
   The final argument is the actual slot role from `Tilesets.json`; omit it only when the filename ends in `_A1`…`_A5` or `_B`…`_E`. The script writes a labelled sample montage and an index JSON. MV uses 48×48 tiles; this workflow does not support plugins that change that geometry.
3. View the montage. Give visible samples short names, a visual description, and `high`, `medium` or `low` confidence. Use the local index from the sample JSON, never a guessed tile ID. Preserve holes. Do not infer passability or gameplay function from appearance.
   ```json
   {"sheet":"CustomDecor","role":"B","autotile":false,"entries":{"3":{"name":"Clay pot","description":"Brown pot with dark rim","confidence":"high","duplicateOf":null}}}
   ```
4. Preview, then apply within the user's authorized project scope:
   ```sh
   node skill/mv-tileset-catalog/scripts/write-catalog.mjs "<workDir>/<Sheet>.naming.json" "<project>" --dry-run
   node skill/mv-tileset-catalog/scripts/write-catalog.mjs "<workDir>/<Sheet>.naming.json" "<project>"
   ```
   The writer updates only `data/tilecatalog/<Sheet>.json`. It preserves entries marked `manual:true`, leaves passability and terrain tags unset, and versions the metadata. Do not run the apply command when the user authorized only an audit or preview.
5. Read the result through `get_tile_catalog(tilesetId, sheet)` and report low-confidence/duplicate samples for review. A corrected entry should carry `manual:true`.

Per-index precedence is manual project metadata, then sidecar or fingerprint-verified MV names, then draft project metadata. Blank sidecar lines allow project labels to fill gaps. Catalog labels guide painting; the project tileset flags remain the source of truth for passage.

The helper scripts are adapted from Redseb/rpgmaker-mz-mcp under MIT; see `THIRD_PARTY_NOTICES.md`.

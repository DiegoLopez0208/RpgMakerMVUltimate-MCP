# Your first useful result

Use Node.js 20.19.0+, a configured MCP client and a **copy** of a licensed MV project. Close the MV editor before editing files. Run `npx -y rpgmaker-mv-mcp --doctor /absolute/project/path` first. Data-only projects can be inspected, but playtests need the engine and assets. Examples below are tool arguments, not JavaScript to paste into the MV editor.

## 1. Find why an event never fires

Ask your agent:

> Inspect my MV project without changing it. Call get_project_context and analyze_project overview. Report incomplete reads first. Find the switch condition on the door I name, then explain whether that switch is ever set ON. Use real IDs from this project.

```text
get_project_context { "detail": "summary" }
analyze_project { "view": "overview" }
analyze_project { "view": "search", "query": "Door" }
query_map { "view": "events", "mapId": 1 }
analyze_project { "view": "explain", "target": "switch", "id": 1 }
```

Replace map/switch IDs with those actually returned. Expected result: event/page conditions and where the switch is read or written. Static analysis cannot prove what a custom script or plugin does to a switch. `complete:false` means the analysis omitted files; resolve the warnings before treating “never set” as conclusive.

## 2. Insert a working MV command with a preview

Build a switch command, preview insertion into the event that should unlock the door, then commit only the intended insertion. Do not blindly turn a switch ON in the blocked door itself: its page may never run.

```text
build_event_commands { "kind": "control_switch", "scope": "switch", "switchId": 1, "value": "on" }
insert_event_commands { "mapId": 1, "eventId": 2, "commands": [{ "code": 121, "indent": 0, "parameters": [1, 1, 0] }], "dryRun": true }
```

Use the builder's actual output and the correct event/page IDs. Inspect the preview before repeating it with `dryRun:false`. Expected result: a valid insertion and backups under `.mcp-backups/`. If a file changed or a backup failed, the operation refuses replacement; reread the project and inspect the error. A lock left by a crashed process must only be removed after confirming that process has stopped.

## 3. Verify the result in the engine

Headless playtests do not need the live bridge plugin. They require optional Playwright, Chromium and the project's own engine/assets.

```text
run_playtest { "steps": [
  { "action": "load", "mapId": 1, "x": 1, "y": 1 },
  { "action": "startEvent", "eventId": 2 },
  { "action": "advanceText" },
  { "action": "eval", "script": "$gameSwitches.value(1)" }
] }
```

Use a reachable position and the event you edited. Expected evidence: `ok:true`, successful steps, the switch value `true`, and no relevant `problems`. Test the door's interaction/transfer separately, because a switch being ON does not establish collision or destination correctness. No screenshots are needed for these text checks.

For a map workflow, generate an RTP-compatible map, inspect `query_map view validate` and `analyze_project view metrics`, wire its events, then run its path. Semantic map generation returns layout markers; it does not automatically create key/locked-door gameplay. Visual quality and third-party plugin compatibility require separate acceptance.

If a recipe helps, a GitHub star helps other MV creators discover it. Bug reports with the command, client version and a small non-sensitive reproduction help improve it. Never upload your credentials or licensed engine/assets in a report.

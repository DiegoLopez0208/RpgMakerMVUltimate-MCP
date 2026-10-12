# Local bundle and verified demo

The [v5.21.0 release](https://github.com/DiegoLopez0208/RpgMakerMVUltimate-MCP/releases/tag/v5.21.0) includes a Windows x64 MCPB bundle, a silent workflow video and its verification evidence.

## Windows x64 bundle

Open `rpgmaker-mv-copilot-mcp-5.21.0-win32-x64.mcpb` in a compatible MCPB client.
Node 20.19.0+ must be supplied by the client or installed locally. Project
selection is optional for discovery and pure event-command builders. Select a
copy of your MV project for project operations and close the editor before edits.

The bundle includes the server, core dependencies, native Sharp for Windows x64,
and bundled reference data. It does not include the RPG Maker engine, game graphics,
Playwright, Chromium or API credentials. Browser playtests need separately
configured Playwright/Chromium and your own runnable project's engine/assets.
Other platforms can use the npm package as described in the README.

SHA-256 of the published bundle:

```text
763210c2be4f740c1e8ff995e9ddc9919ae4c428a4936505d2fab5072fcd4ac3
```

Validation covered the MCPB manifest, native Sharp, and MCP stdio calls from the
unpacked bundle: discovery of 18 tools, project-free command building, reference
templates and writes to a disposable fixture. The download from itch.io matched
this SHA-256. Installation through individual MCPB host applications still needs
host-specific acceptance testing.

## Door workflow demonstration

`door-demo.mp4` and `door-demo.gif` visually replay actual verified MCP results.
They are a presentation of recorded results, rather than a live client recording.
`door-demo-evidence.json` contains the corresponding before/after observations.

The controlled fixture was a private copy of MV's blank project. Its door page
required switch 1 (`DoorUnlocked`), which had no setter. Through MCP stdio, the
verification called `analyze_project`, built a valid MV switch command, previewed
and inserted it into the unlock lever, then called `run_playtest` again. In MV
1.6.1 the switch became true, the door page activated, and the dialogue was
`The door is unlocked.` No runtime problems were reported.

The fixture's engine and game graphics are not distributed in these artifacts.

## Directory pages

- [itch.io](https://bycht.itch.io/rpgmaker-mv-copilot-mcp): bundle, animated preview and video.
- [Smithery](https://smithery.ai/servers/lopezdiegog26/rpgmaker-mv-copilot-mcp): local bundle and 18 tool definitions.

Cline Marketplace submission remains pending its required installation test with
the Cline client; generic MCP tests do not substitute for that requirement.

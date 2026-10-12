# Docker and directory build configuration

Build and verify the image from the repository root:

```sh
docker build -t rpgmaker-mv-mcp:docker-test .
node scripts/verify-docker-protocol.mjs
```

The verification script requires `npm ci` on the host. It checks MCP discovery,
project-free command builders, bundled map templates, native Sharp, and reads and
writes in a disposable mounted project. The image runs as the `node` user and
includes production dependencies only.

For an MCP client, use `docker` as the command with these arguments:

```json
["run", "--rm", "-i", "--mount", "type=bind,source=/absolute/path/to/MV-project,target=/app/project", "-e", "RPGMAKER_PROJECT_PATH=/app/project", "rpgmaker-mv-mcp:docker-test"]
```

Use an absolute host path (on Windows, e.g. `C:/Games/MyProject`). The mounted
project must be writable by the container user for editing. Do not allocate a
TTY (`-t`): this is a stdio MCP server. Without a mount and project environment
variable, discovery and pure builders work; project operations request a project.
The image does not include Chromium or the RPG Maker engine. Browser playtests
require a separately configured browser and a runnable project.

## Glama Build Spec

Glama generates its own Dockerfile; its Build Spec does not use this repository's
Dockerfile. With Node 22 or 24, use:

```json
{
  "buildSteps": ["npm ci", "npm run build"],
  "cmdArguments": ["mcp-proxy", "--", "node", "dist/index.js"],
  "placeholderArguments": {}
}
```

No dummy game is needed to discover tools. Remove the `/app/project` placeholder
unless an actual project is mounted there. This configuration does not provision
a game for hosted editing or playtesting.

A Docker API HTTP 502 with empty build logs does not identify an npm or server
failure. Retry the directory build against the current commit; if it repeats,
report the build ID, timestamp and empty logs to the directory's support.

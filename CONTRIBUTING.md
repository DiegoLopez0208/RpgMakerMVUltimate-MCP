# Contributing

## Setup

```bash
git clone <repo-url>
cd RpgMakerMVUltimate-MCP
npm install
```

## Style

- **CommonJS only** — no TypeScript, no ESM imports
- **No build step** — everything runs directly with Node.js
- **No comments** — let the code speak for itself (JSDoc on public functions is OK)
- **var** over **let/const** is acceptable in existing files; new code can use either
- 2-space indentation

## Adding a Tool

1. Create/extend the tool module in `tools/`
2. Add the tool definition to `TOOL_DEFINITIONS` in `server.js`
3. Add the handler case in `handleToolCall` in `server.js`
4. Test with a real RPG Maker MV project

## Adding a Knowledge File

1. Add the JSON file to `knowledge/`
2. Update `knowledge/README.md`
3. Reference it from the tool that needs it

## Testing

There is no test framework. Verify changes by:

1. `node -e "require('./server.js')"` — server loads without crash
2. `node -e "require('./tools/YOUR_TOOL')"` — module loads
3. Test against a real project with `RPGMAKER_PROJECT_PATH` set

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Update CHANGELOG.md under "Unreleased"
- Ensure `node server.js` starts without errors

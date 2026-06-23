# Contributing to RPG Maker MV Ultimate MCP

## Setup

```bash
git clone <repo-url>
cd RpgMakerMVUltimate-MCP
npm install
```

## Technology Stack

- **TypeScript** — all source is in `src/**/*.ts`
- **ESM** — native ES modules (`import`/`export`)
- **Node.js 18+** — required for `fs/promises`, `import.meta`, etc.
- **Vitest** — test framework (`npm test`)
- **No build step** — TypeScript runs via `tsx` or `ts-node` in development

## Code Style

- **`const`/`let`** — `var` is legacy; use `const` by default, `let` only when rebinding
- **Async I/O** — prefer `fs/promises` (`readFile`, `readdir`) over sync variants
- **2-space indentation**
- **Comments** — minimal but necessary: explain *why*, not *what*. JSDoc on public APIs is encouraged
- **No `any`** — use strict types; `unknown` with narrowing is preferred

## Architecture

### Dual Tool System

The server exposes tools through **two parallel systems**:

1. **Legacy tools** (`server.ts`) — direct function dispatch via `executeTool()`
2. **Consolidated tools** (`router.ts`) — higher-level routing with richer parameters

When adding a tool, you usually need to update **both**.

### Adding a Map Tool

1. **Implement** in `src/tools/mapTools.ts` (or `systemTools.ts`, `projectTools.ts`, etc.)
2. **Export** it at the bottom of the file
3. **Wire legacy handler** in `src/server.ts` `handleToolCall` switch
4. **Wire router** in `src/router.ts` `routeTool` switch (if it maps to a consolidated tool name)
5. **Add tool definition** in `src/toolDefinitionsLegacy.ts` (legacy) and/or `src/toolDefinitions.ts` (consolidated)
6. **Write tests** in `tests/integration.test.ts` following TDD: RED → GREEN → refactor

### Adding a System / Project Tool

Same pattern as map tools, but implement in `src/tools/systemTools.ts` or `src/tools/projectTools.ts`.

### Database Tools

Database operations use the CRUD helper (`src/utils/crudHelper.ts`). For a new entity:

1. Create the typed interface in `src/types/rpgmaker.ts`
2. Use `createCrud(entityName, factoryFn)` in your tool module
3. Export wrapped functions

## Testing

```bash
# Run all tests
npm test

# Run with more memory (integration tests load large fixtures)
node --max-old-space-size=8192 ./node_modules/.bin/vitest run

# Type-check without emitting
npx tsc --noEmit
```

### Test Patterns

- Integration tests live in `tests/integration.test.ts`
- Validation tests live in `tests/validation.test.ts`
- Each test creates a temporary project under `/tmp/rpgmv-test-XXXXXX`
- Use `dispatchTool("tool_name", args)` to exercise the full stack
- Clean up is automatic via `afterAll(() => rmSync(projectDir, { recursive: true }))`

### TDD Workflow

1. Write the **failing test** first (RED)
2. Implement the **smallest change** to make it pass (GREEN)
3. **Refactor** if needed while keeping tests green
4. Capture both test output and real-surface evidence in the durable notepad

## State & Mutability

- **Never use module-level mutable state** for per-request data (e.g., tileset context during map generation). Pass state through function parameters or context objects
- Module-level caches (e.g., `Map<number, T>`) are OK if they're read-only after initialization

## File Organization

```
src/
  server.ts          — MCP server entry, legacy tool dispatch, getProjectContext
  router.ts          — Consolidated tool routing, parameter transformation
  toolDefinitions.ts — Consolidated (12-tool) JSON schemas
  toolDefinitionsLegacy.ts — Legacy tool JSON schemas
  types/rpgmaker.ts  — Shared TypeScript interfaces
  tools/             — Tool implementations (map, system, project, enemy, skill, asset, tileset)
  utils/             — Shared utilities (mapGenerator, autotile, validation, security, etc.)
  data/              — Static data (engine defaults, tileset tables)
  knowledge/         — Bundled reference maps and stamp libraries
tests/
  integration.test.ts — End-to-end tests
  validation.test.ts  — Schema validation tests
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Update `CHANGELOG.md` under "Unreleased"
- Ensure `npx tsc --noEmit` passes
- Ensure `npm test` passes (all suites)
- If adding a tool, include integration tests

## Common Pitfalls

- **Forgetting router wiring** — a legacy tool works but the consolidated alias fails
- **Missing exports** — function implemented but not exported from the tool module
- **Sync I/O in async paths** — prefer `readFile` over `readFileSync` in async functions
- **Module-level state leaks** — concurrent requests can corrupt shared mutable variables

#!/usr/bin/env node
// CLI entry point: starts the MCP server. server.ts has no import side effects
// so tests can import executeTool/dispatchTool without booting the server.
import { main } from "./server.js";
import * as logger from "./utils/logger.js";
import { diagnoseEnvironment } from './diagnostics.js';

async function start() {
  if (process.argv[2] === '--doctor') {
    const result = await diagnoseEnvironment(process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.coreReady ? 0 : 1;
    return;
  }
  await main();
}

start().catch(function (error) {
  logger.error("Fatal error starting server: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

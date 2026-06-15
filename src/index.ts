#!/usr/bin/env node
// CLI entry point: starts the MCP server. server.ts has no import side effects
// so tests can import executeTool/dispatchTool without booting the server.
import { main } from "./server.js";
import * as logger from "./utils/logger.js";

main().catch(function (error) {
  logger.error("Fatal error starting server: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

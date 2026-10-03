import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS_LEGACY } from '../toolDefinitionsLegacy.js';
import { EVENT_COMMAND_TOOL_DEFINITIONS } from '../eventCommandDefinitions.js';
import { type ToolContext, type ToolDefinition, buildRegistry, schemaFor, shapeResult } from './registry.js';
import { actorToolDefinitions } from './tools/actorTools.js';
import { itemToolDefinitions } from './tools/itemTools.js';
import { skillToolDefinitions } from './tools/skillTools.js';
import { mapToolDefinitions } from './tools/mapTools.js';
import { battleToolDefinitions } from './tools/battleTools.js';
import { classToolDefinitions } from './tools/classTools.js';
import { stateToolDefinitions } from './tools/stateTools.js';
import { commonEventToolDefinitions } from './tools/commonEventTools.js';
import { moveToolDefinitions } from './tools/moveTools.js';
import { eventCommandToolDefinitions } from './tools/eventCommandTools.js';
import { eventPageToolDefinitions } from './tools/eventPageTools.js';
import { pluginToolDefinitions } from './tools/pluginTools.js';
import { tileToolDefinitions } from './tools/tileTools.js';
import { catalogToolDefinitions } from './tools/catalogTools.js';
import { paintToolDefinitions } from './tools/paintTools.js';
import { objectToolDefinitions } from './tools/objectTools.js';
import { tilesetToolDefinitions } from './tools/tilesetTools.js';
import { systemToolDefinitions } from './tools/systemTools.js';
import { assetToolDefinitions } from './tools/assetTools.js';
import { listToolDefinitions } from './tools/listTools.js';
import { validationToolDefinitions } from './tools/validationTools.js';
import { pluginScanToolDefinitions } from './tools/pluginScanTools.js';
import { batchToolDefinitions } from './tools/batchTools.js';
import { idToolDefinitions } from './tools/idTools.js';
import { exportToolDefinitions } from './tools/exportTools.js';
import { recordToolDefinitions } from './tools/recordTools.js';
import { playtestToolDefinitions } from './tools/playtestTools.js';

// Existing public and legacy contracts keep their implementations and argument
// shapes. The port supplies new operations, not silent replacements for aliases.
const reserved = new Set([
  ...TOOL_DEFINITIONS_LEGACY.map(t => t.name),
  ...EVENT_COMMAND_TOOL_DEFINITIONS.map(t => t.name),
]);
export const parityDefinitions: ToolDefinition[] = [
  ...actorToolDefinitions, ...itemToolDefinitions, ...skillToolDefinitions,
  ...mapToolDefinitions, ...battleToolDefinitions, ...classToolDefinitions,
  ...stateToolDefinitions, ...commonEventToolDefinitions, ...moveToolDefinitions,
  ...eventCommandToolDefinitions, ...eventPageToolDefinitions, ...pluginToolDefinitions,
  ...tileToolDefinitions, ...catalogToolDefinitions, ...paintToolDefinitions,
  ...objectToolDefinitions, ...tilesetToolDefinitions, ...systemToolDefinitions,
  ...assetToolDefinitions, ...listToolDefinitions, ...validationToolDefinitions,
  ...pluginScanToolDefinitions, ...batchToolDefinitions, ...idToolDefinitions,
  ...exportToolDefinitions, ...recordToolDefinitions, ...playtestToolDefinitions,
].filter(def => !reserved.has(def.name));

export const parityRegistry = buildRegistry(parityDefinitions);
export const PARITY_TOOLS: Tool[] = parityDefinitions.map(def => ({
  name: def.name,
  description: def.description,
  annotations: def.annotations ?? {
    readOnlyHint: !def.mutates, destructiveHint: !!def.mutates,
    openWorldHint: false,
  },
  inputSchema: zodToJsonSchema(z.object(schemaFor(def)).strict(), { $refStrategy: 'none' }) as Tool['inputSchema'],
}));

export async function callParityTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const def = parityRegistry.get(name);
  if (!def) throw new Error(`Unknown parity tool ${name}`);
  const parsed = z.object(schemaFor(def)).strict().parse(args);
  const result = await def.handler(ctx, parsed);
  return shapeResult(def, result, parsed);
}

export function parityRequiresProject(name: string): boolean {
  const def = parityRegistry.get(name);
  if (!def) return true;
  // Command/route/troop-page builders are pure, even when an upstream definition
  // left the default project requirement on them.
  return def.requiresProject !== false && !name.startsWith('build_') && name !== 'create_move_route';
}

import { z } from 'zod';
import type { ToolDefinition } from '../registry.js';
import { projectPluginRegistry } from './pluginScanTools.js';

export const pluginToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_plugin_commands',
    description: 'Inspect command annotations supplied by installed plugins. Classic MV plugins usually document commands only in @help; no argument order or MZ-style registration is assumed. Use analyze_project view plugins to read help excerpts.',
    inputSchema: { pluginName: z.string().optional() },
    handler: async (ctx, args) => {
      const registry = await projectPluginRegistry(ctx.projectPath);
      if (args.pluginName && !registry[args.pluginName]) throw new Error(`Plugin ${args.pluginName} not found`);
      return { plugins: args.pluginName ? { [args.pluginName]: registry[args.pluginName] } : registry,
        coverage: 'Annotations are documentation only. MV dispatches one raw command string split on spaces; plugin-specific parsing must be confirmed from its help/source.' };
    },
  },
  {
    name: 'create_plugin_command',
    description: 'Build an MV code 356 command from its exact documented text, e.g. "DoorCtl open 1". Optional pluginName checks installation/enabled state. Emits one string, never MZ code 357 or inferred named arguments.',
    inputSchema: { text: z.string().min(1), pluginName: z.string().optional(), indent: z.number().int().min(0).max(100).default(0) },
    handler: async (ctx, args) => {
      if (!args.text.trim() || /[\r\n]/.test(args.text)) throw new Error('Plugin command text must be one nonempty line');
      const warnings: string[] = [];
      if (args.pluginName) {
        const registry = await projectPluginRegistry(ctx.projectPath);
        const plugin = registry[args.pluginName];
        if (!plugin) warnings.push(`Plugin ${args.pluginName} has no discoverable command metadata`);
        else if (plugin.enabled === false) warnings.push(`Plugin ${args.pluginName} is disabled`);
      }
      return { command: { code: 356, indent: args.indent, parameters: [args.text] }, warnings };
    },
  },
];

import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Context passed to every tool handler. Kept as an object (rather than a bare
 * `projectPath` string) so cross-cutting state — e.g. a future dry-run flag or
 * logger — can be threaded through without changing every handler signature.
 */
export interface ToolContext {
  projectPath: string;
  /**
   * Retarget the server at a different project directory for the rest of the
   * session. Provided by the server entry point; only `set_project` calls it.
   */
  setProjectPath?: (path: string) => void | Promise<void>;
  /** Optional client-requested progress notifications for long running tools. */
  reportProgress?: (progress: number, total?: number, message?: string) => void;
}

/**
 * A tool's input schema, expressed as a Zod "raw shape" (a map of argument name
 * to Zod type). The MCP SDK's `registerTool` consumes this directly: it both
 * advertises the JSON Schema to clients and validates incoming arguments before
 * the handler runs, so handlers can trust their inputs.
 */
export type InputShape = Record<string, z.ZodType>;

/**
 * A single MCP tool: its schema (advertised to clients and used for validation)
 * plus the handler that runs it. Each tool module owns its own definitions, so
 * adding a tool means editing one file instead of a central schema list and a
 * central dispatch switch.
 */
export interface ToolDefinition {
  name: string;
  /** Protocol hints, including runtime side effects outside disk commits. */
  annotations?: ToolAnnotations;
  description: string;
  inputSchema: InputShape;
  // Values are parsed by the per-tool Zod schema immediately before dispatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
  /**
   * True for tools that write to the project. Such tools accept a `dryRun`
   * argument (injected into their advertised schema at registration time) and
   * are run inside a commit context so the write can be previewed instead of
   * applied.
   */
  mutates?: boolean;
  /**
   * True for mutating tools whose validation can *refuse* a write: they check
   * the would-be result before committing and throw on a structural problem
   * rather than writing it and warning. Such tools accept a `force` argument
   * (injected into their advertised schema at registration time) to override.
   * Only set this where a handler actually gates on `args.force` — otherwise the
   * advertised argument would do nothing.
   */
  forceable?: boolean;
  /**
   * False for the few tools that must run without a configured project path
   * (`get_project`/`set_project` — the tools you'd use to diagnose or fix an
   * unset path). Everything else defaults to true and is gated on a valid
   * project path before its handler runs.
   */
  requiresProject?: boolean;
  /**
   * Condense this tool's result before it is serialized back to the caller.
   *
   * Set it on write tools that would otherwise echo a large record they did not
   * meaningfully change — `update_map` replaying every event's command list,
   * `insert_event_commands` re-printing the whole list on every splice. The
   * caller paying for that echo is an AI assistant whose context is the scarce
   * resource, and the full record is always one read-only call away.
   *
   * Declaring one also advertises `verbose` on the tool (see `VERBOSE_SHAPE`),
   * so a caller who does want the full record can ask for it per call. Tools
   * without a summarizer do not advertise `verbose` — the same discipline
   * `force` follows, since an advertised argument that does nothing is a lie.
   */
  summarize?: (result: unknown) => unknown;
  /** PNG files to attach beside JSON output, as supported by upstream render tools. */
  images?: (result: unknown, args: Record<string, unknown>) => string[];
}

/**
 * The shared `dryRun` argument advertised on every mutating tool. Injected into
 * the tool's schema at registration so clients can discover it without each tool
 * having to declare it.
 */
export const DRY_RUN_SHAPE = {
  dryRun: z
    .boolean()
    .optional()
    .describe('Preview only: return a diff of what would change without writing to disk.'),
} as const;

/**
 * The shared `force` argument advertised on mutating tools that gate their write
 * on validation. Injected the same way `dryRun` is, but only for `forceable`
 * tools — advertising it on a tool that never refuses a write would be a lie.
 */
export const FORCE_SHAPE = {
  force: z
    .boolean()
    .optional()
    .describe(
      'Write even if validation finds structural problems (wrong parameter count, unterminated command list). Off by default: such a write is refused and nothing is written. Advisory warnings never block regardless.',
    ),
} as const;

/**
 * The shared `verbose` argument advertised on tools that condense their result.
 * Injected the same way `force` is, and only where a `summarize` function exists
 * for it to override.
 */
export const VERBOSE_SHAPE = {
  verbose: z
    .boolean()
    .optional()
    .describe(
      'Echo the full written record instead of the default summary. Off by default: the response reports identity, counts and command-list shape, which is what you would assert on, and omits the parameters/conditions you would only re-read. Read the full record with the matching get_* tool.',
    ),
} as const;

/**
 * Resolve the Zod raw shape a tool should be registered with. Mutating tools get
 * the shared `dryRun` argument folded in, those that gate on validation also get
 * `force`, and those that condense their echo also get `verbose`.
 */
export function schemaFor(def: ToolDefinition): InputShape {
  const withVerbose = def.summarize ? VERBOSE_SHAPE : {};
  if (!def.mutates) return { ...def.inputSchema, ...withVerbose };
  return {
    ...def.inputSchema,
    ...DRY_RUN_SHAPE,
    ...(def.forceable ? FORCE_SHAPE : {}),
    ...withVerbose,
  };
}

/**
 * Apply a tool's summarizer to its result unless the caller asked for the full
 * record. Kept here rather than in the server entry point so the rule is
 * testable without standing up an McpServer, and so the dry-run path can reuse
 * it for `wouldReturn` — a preview that echoed the full record while the real
 * call summarized it would be its own trap.
 */
export function shapeResult(
  def: ToolDefinition,
  result: unknown,
  args: Record<string, unknown>,
): unknown {
  if (!def.summarize || args.verbose === true || result === undefined) return result;
  return def.summarize(result);
}

/** Index definitions by name, failing loudly on duplicates. */
export function buildRegistry(defs: ToolDefinition[]): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const def of defs) {
    if (registry.has(def.name)) {
      throw new Error(`Duplicate tool definition: ${def.name}`);
    }
    registry.set(def.name, def);
  }
  return registry;
}

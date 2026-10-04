/**
 * toolProfiles.ts — which consolidated tools a session advertises.
 *
 * Every advertised tool costs its schema in the client's context on every
 * session, whether or not it is used. RPGMV_TOOLSET lets a client that only
 * edits data skip the event builders, the map generator or the capture tools.
 * Unset (or "all") keeps the full list, so nothing changes by default.
 *
 * Each consolidated tool belongs to exactly one profile (a test enforces it, so
 * a new tool must be placed deliberately). "core" is always included: without
 * it a session could not select a project or read the database.
 */

export const TOOL_PROFILES = {
  core: [
    'set_project_path', 'get_project_context', 'query_database', 'create_database_entry',
    'update_database_entry', 'delete_database_entry', 'query_map', 'edit_map',
    'manage_map_event', 'manage_system', 'analyze_project',
  ],
  events: ['build_event_commands', 'insert_event_commands'],
  mapgen: ['generate_map'],
  media: ['take_screenshot', 'record_video', 'analyze_image'],
} as const satisfies Record<string, readonly string[]>;

export type ToolProfile = keyof typeof TOOL_PROFILES;

/**
 * Parse RPGMV_TOOLSET ("events,media", case and spaces ignored). Returns the
 * enabled tool names, or null for every tool. Unknown profiles throw at startup
 * rather than silently hiding tools.
 */
export function parseToolset(value: string | undefined): Set<string> | null {
  const requested = (value ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0 || requested.includes('all')) return null;
  const unknown = requested.filter(name => !(name in TOOL_PROFILES));
  if (unknown.length) {
    throw new Error('Unknown RPGMV_TOOLSET profile(s): ' + unknown.join(', ') + '. Valid: all, ' + Object.keys(TOOL_PROFILES).join(', ') + '.');
  }
  const profiles = new Set<ToolProfile>(['core', ...(requested as ToolProfile[])]);
  return new Set([...profiles].flatMap(profile => TOOL_PROFILES[profile]));
}

/** The profile a consolidated tool belongs to, or undefined for legacy names. */
export function profileOf(tool: string): ToolProfile | undefined {
  return (Object.keys(TOOL_PROFILES) as ToolProfile[]).find(profile => (TOOL_PROFILES[profile] as readonly string[]).includes(tool));
}

/**
 * Drop keys whose value is `undefined` so a caller's omitted optional field can't
 * clobber a template default when spread over it. Used by every `create_*` tool
 * that merges caller overrides onto a `default*()` template (`{ ...template,
 * ...definedOnly(overrides), id }`).
 */
export function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

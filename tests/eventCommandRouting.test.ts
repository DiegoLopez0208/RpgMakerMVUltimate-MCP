import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool, executeTool } from '../src/server.js';
import { TOOL_DEFINITIONS } from '../src/toolDefinitions.js';
import { TOOL_DEFINITIONS_LEGACY } from '../src/toolDefinitionsLegacy.js';
import { TOOL_NAMES } from '../src/router.js';
import { setProjectPath } from '../src/tools/projectTools.js';
import type { EventCommand } from '../src/types/rpgmaker.js';

describe('event command MCP routing', () => {
  let project: string;
  const end: EventCommand = { code: 0, indent: 0, parameters: [] };
  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'rpgmv-builder-routing-'));
    await mkdir(path.join(project, 'data'));
    await writeFile(path.join(project, 'data/System.json'), JSON.stringify({ gameTitle: 'Builder routing', switches: ['', 'Door'], variables: ['', 'Count'] }));
    await writeFile(path.join(project, 'data/Map001.json'), JSON.stringify({ width: 5, height: 5, data: [], events: [null, { id: 1, name: 'Guide', x: 1, y: 1, pages: [{ list: [end] }] }] }));
    await setProjectPath(project);
  });
  afterEach(async () => {
    if (project) await rm(project, { recursive: true, force: true });
  });

  it('advertises both operations on consolidated and legacy surfaces', () => {
    for (const name of ['build_event_commands', 'insert_event_commands']) {
      expect(TOOL_NAMES).toContain(name);
      expect(TOOL_DEFINITIONS.filter(t => t.name === name)).toHaveLength(1);
      expect(TOOL_DEFINITIONS_LEGACY.filter(t => t.name === name)).toHaveLength(1);
    }
  });

  it('routes to the same pure builder through both dispatch paths', async () => {
    const args = { kind: 'show_text', lines: ['Hello'], faceName: 'Actor1', faceIndex: '2' };
    const expected = { commands: [{ code: 101, indent: 0, parameters: ['Actor1', 2, 0, 2] }, { code: 401, indent: 0, parameters: ['Hello'] }] };
    expect(await executeTool('build_event_commands', args)).toMatchObject(expected);
    expect(await dispatchTool('build_event_commands', args)).toMatchObject(expected);
  });

  it('previews a composed fragment without writing, then commits the same list', async () => {
    const { commands } = await dispatchTool('build_event_commands', { kind: 'control_switch', scope: 'switch', switchId: '1', value: 'on' }) as { commands: EventCommand[] };
    const file = path.join(project, 'data/Map001.json');
    const before = await readFile(file, 'utf8');
    const args = { target: 'map_event', mapId: 1, eventId: 1, commands };
    const preview = await dispatchTool('insert_event_commands', { ...args, dryRun: true });
    expect(preview).toMatchObject({ dryRun: true });
    expect(await readFile(file, 'utf8')).toBe(before);
    await dispatchTool('insert_event_commands', args);
    const map = JSON.parse(await readFile(file, 'utf8'));
    expect(map.events[1].pages[0].list).toEqual([...commands, end]);
    expect(map.events[1].name).toBe('Guide');
  });

  it('refuses MZ text arguments and malformed insertions without changing data', async () => {
    await expect(dispatchTool('build_event_commands', { kind: 'show_text', lines: ['Hello'], speakerName: 'MZ only' })).rejects.toThrow();
    const file = path.join(project, 'data/Map001.json');
    const before = await readFile(file, 'utf8');
    await expect(dispatchTool('insert_event_commands', { mapId: 1, eventId: 1, commands: [{ code: 111, indent: 0, parameters: [0, 1, 0] }] })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

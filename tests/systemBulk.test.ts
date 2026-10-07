import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';

const dirs: string[] = [];
let project: string;
const write = (name: string, value: unknown) => writeFileSync(path.join(project, 'data', name), JSON.stringify(value));
const readSystem = () => JSON.parse(readFileSync(path.join(project, 'data', 'System.json'), 'utf8')) as { switches: Array<string | null>; variables: Array<string | null> };
const system = (args: Record<string, unknown>) => dispatchTool('manage_system', args);

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mv-sysbulk-'));
  dirs.push(project);
  mkdirSync(path.join(project, 'data'));
  mkdirSync(path.join(project, 'js', 'plugins'), { recursive: true });
  write('System.json', { gameTitle: 'T', startMapId: 1, startX: 0, startY: 0, partyMembers: [], switches: [null, 'Door', ''], variables: [null, 'Gold', '', ''] });
  write('MapInfos.json', [null]);
  for (const name of ['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'States', 'Troops', 'Animations', 'CommonEvents', 'Tilesets']) write(name + '.json', [null]);
  initProjectPath(project);
});
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('manage_system resize_list', () => {
  it('grows variables to a new highest id, keeping names and leaving index 0 empty', async () => {
    const result = await system({ action: 'resize_list', section: 'variables', size: 100 });
    expect(result).toEqual({ section: 'variables', previousMax: 3, max: 100 });
    const { variables } = readSystem();
    expect(variables).toHaveLength(101);
    expect(variables[0]).toBeNull();
    expect(variables[1]).toBe('Gold');
    expect(variables[100]).toBe('');
  });

  it('shrinks over unnamed ids, and refuses to drop named ones unless forced', async () => {
    await system({ action: 'resize_list', section: 'switches', size: 1 });
    expect(readSystem().switches).toEqual([null, 'Door']);
    write('System.json', { switches: [null, 'Door', 'Lever'], variables: [null] });
    await expect(system({ action: 'resize_list', section: 'switches', size: 1 })).rejects.toThrow('drops named ids (2 "Lever")');
    expect(readSystem().switches).toHaveLength(3);
    await system({ action: 'resize_list', section: 'switches', size: 1, force: true });
    expect(readSystem().switches).toEqual([null, 'Door']);
  });

  it('rejects bad sections and sizes', async () => {
    await expect(system({ action: 'resize_list', section: 'actors', size: 10 })).rejects.toThrow('section: Invalid enum value');
    await expect(system({ action: 'resize_list', section: 'variables', size: 0 })).rejects.toThrow('size is the highest valid id');
    await expect(system({ action: 'resize_list', section: 'variables', size: 5001 })).rejects.toThrow('1 to 5000');
    await expect(system({ action: 'resize_list', section: 'variables', size: 2.5 })).rejects.toThrow('integer');
  });
});

describe('manage_system list_backups / restore_backup', () => {
  it('lists the copies kept before each write, newest first', async () => {
    await system({ action: 'name_variable', id: 2, name: 'One' });
    await system({ action: 'name_variable', id: 2, name: 'Two' });
    const all = await system({ action: 'list_backups' }) as { files: Array<{ file: string; backups: Array<{ id: string }> }> };
    const entry = all.files.find((f) => f.file === 'System.json')!;
    expect(entry.backups).toHaveLength(2);
    expect(entry.backups[0].id > entry.backups[1].id).toBe(true);
    const only = await system({ action: 'list_backups', file: 'Items.json' }) as { files: unknown[] };
    expect(only.files).toEqual([]);
  });

  it('restores the newest backup, which undoes the last write, and keeps what it replaced', async () => {
    await system({ action: 'name_variable', id: 2, name: 'One' });
    await system({ action: 'name_variable', id: 2, name: 'Two' });
    expect(readSystem().variables[2]).toBe('Two');
    const result = await system({ action: 'restore_backup', file: 'System.json' }) as { restored: string };
    expect(readSystem().variables[2]).toBe('One');
    const after = await system({ action: 'list_backups', file: 'System.json' }) as { files: Array<{ backups: Array<{ id: string }> }> };
    expect(after.files[0].backups).toHaveLength(3);
    // restoring again, by id, brings back the version the first restore replaced
    const replaced = after.files[0].backups[0].id;
    expect(replaced).not.toBe(result.restored);
    await system({ action: 'restore_backup', file: 'System.json', backup: replaced });
    expect(readSystem().variables[2]).toBe('Two');
  });

  it('refuses unknown files, ids and backups that are not valid JSON', async () => {
    await expect(system({ action: 'restore_backup', file: 'Items.json' })).rejects.toThrow('No backups of Items.json');
    await expect(system({ action: 'restore_backup', file: '../secret.json' })).rejects.toThrow('Cannot restore');
    await expect(system({ action: 'restore_backup', file: 'System.json/../x.json' })).rejects.toThrow('Cannot restore');
    await system({ action: 'name_variable', id: 2, name: 'One' });
    await expect(system({ action: 'restore_backup', file: 'System.json', backup: '19990101-000000-000' })).rejects.toThrow('No backup "19990101-000000-000"');
    const dir = path.join(project, '.mcp-backups');
    writeFileSync(path.join(dir, 'Troops.20260101-000000-000.json'), '{not json');
    await expect(system({ action: 'restore_backup', file: 'Troops.json' })).rejects.toThrow('not valid JSON');
    expect(readFileSync(path.join(project, 'data', 'Troops.json'), 'utf8')).toBe('[null]');
  });

  it('restores js/plugins.js by name', async () => {
    await system({ action: 'create_plugin', name: 'One' });
    await system({ action: 'create_plugin', name: 'Two' });
    const names = () => (readFileSync(path.join(project, 'js', 'plugins.js'), 'utf8').match(/"name":"(\w+)"/g) ?? []).map((m) => m.slice(8, -1));
    expect(names()).toEqual(['One', 'Two']);
    await system({ action: 'restore_backup', file: 'plugins.js' });
    expect(names()).toEqual(['One']);
  });
});

describe('create_database_entry entries', () => {
  it('creates several entries in one call with consecutive ids', async () => {
    const result = await dispatchTool('create_database_entry', { entity: 'items', entries: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }) as { count: number; created: Array<{ id: number; name: string }> };
    expect(result.count).toBe(3);
    expect(result.created.map((item) => [item.id, item.name])).toEqual([[1, 'A'], [2, 'B'], [3, 'C']]);
    const items = JSON.parse(readFileSync(path.join(project, 'data', 'Items.json'), 'utf8')) as Array<{ name: string } | null>;
    expect(items.slice(1).map((item) => item!.name)).toEqual(['A', 'B', 'C']);
  });

  it('names the entry that failed and the ones already created', async () => {
    await expect(dispatchTool('create_database_entry', { entity: 'tilesets', entries: [{ name: 'A' }] })).rejects.toThrow('entries[0] failed');
    await expect(dispatchTool('create_database_entry', { entity: 'items', entries: [{ name: 'A' }, 'nope'] })).rejects.toThrow(/entries\[1\] failed.*1 earlier entries were created \(ids 1\)/);
  });

  it('rejects an empty or oversized list', async () => {
    await expect(dispatchTool('create_database_entry', { entity: 'items', entries: [] })).rejects.toThrow('1 to 200');
    await expect(dispatchTool('create_database_entry', { entity: 'items', entries: new Array(201).fill({ name: 'x' }) })).rejects.toThrow('1 to 200');
  });
});

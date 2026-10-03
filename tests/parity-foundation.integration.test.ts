import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchTool } from '../src/server.js';
import { initProjectPath } from '../src/tools/projectTools.js';
import { PARITY_TOOLS, parityDefinitions } from '../src/parity/tools.js';
import { listAllocatedIds, nextFreeId } from '../src/parity/tools/idTools.js';
import { evaluateFormula, REFERENCE_CONTEXT } from '../src/utils/formulaEval.js';
import type { CommitResult } from '../src/parity/utils/commit.js';

let dir: string;
const end = { code: 0, indent: 0, parameters: [] };
const write = (file: string, data: unknown) => writeFile(join(dir, 'data', file), JSON.stringify(data));
const read = async (file: string) => JSON.parse(await readFile(join(dir, 'data', file), 'utf8'));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mv-parity-foundation-'));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'js'));
  for (const table of ['Actors', 'Classes', 'Skills', 'Items', 'Weapons', 'Armors', 'Enemies', 'Troops', 'States', 'Animations', 'Tilesets', 'CommonEvents', 'MapInfos']) await write(table + '.json', [null]);
  await write('System.json', { gameTitle: 'Fixture', switches: ['', 'Reserved'], variables: [''], currencyUnit: 'G' });
  await writeFile(join(dir, 'js/plugins.js'), 'var $plugins = [{"name":"Sample","status":true,"parameters":{"n":"5"}}];\n');
  initProjectPath(dir);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('shared parity integration', () => {
  it('keeps detailed legacy write previews without files or backups', async () => {
    const before = await readFile(join(dir, 'data/System.json'), 'utf8');
    const result = await dispatchTool('manage_system', { action: 'set_title', title: 'Preview', dryRun: true }) as { commits: CommitResult[] };
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].diff.changes).toContainEqual({ path: 'gameTitle', from: 'Fixture', to: 'Preview' });
    expect(await readFile(join(dir, 'data/System.json'), 'utf8')).toBe(before);
    expect(await readdir(dir)).toEqual(['data', 'js']);
  });

  it('previews manifest toggles and plugin creation as a protected pair', async () => {
    const file = join(dir, 'js/plugins.js');
    const before = await readFile(file, 'utf8');
    await dispatchTool('toggle_plugin', { pluginName: 'Sample', enabled: false, dryRun: true });
    expect(await readFile(file, 'utf8')).toBe(before);
    const result = await dispatchTool('create_plugin', { name: 'Fresh', dryRun: true }) as { commits: CommitResult[] };
    expect(result.commits).toHaveLength(2);
    expect(await readdir(join(dir, 'js'))).toEqual(['plugins.js']);
    expect(await readFile(file, 'utf8')).toBe(before);
    await dispatchTool('toggle_plugin', { pluginName: 'Sample', enabled: false });
    const status = await dispatchTool('get_plugin_status', {}) as Array<{ status: boolean; parameters: unknown }>;
    expect(status[0]).toMatchObject({ status: false, parameters: { n: '5' } });
    expect((await read('System.json')).plugins).toBeUndefined();
  });

  it.each(['var $plugins = notJson;', 'runSomething(); var $plugins = [];', 'var other = [];'])('preserves unsupported manifests: %s', async source => {
    const file = join(dir, 'js/plugins.js');
    await writeFile(file, source);
    await expect(dispatchTool('create_plugin', { name: 'Fresh' })).rejects.toThrow(/parse/);
    expect(await readFile(file, 'utf8')).toBe(source);
    expect(await readdir(join(dir, 'js'))).toEqual(['plugins.js']);
  });

  it('previews template mining without creating its cache', async () => {
    await dispatchTool('manage_system', { action: 'mine_templates', dryRun: true });
    expect(await readdir(dir)).toEqual(['data', 'js']);
  });

  it('batch-creates MV database rows through the public dispatcher', async () => {
    const args = { type: 'skill', records: [{ name: 'Frost', description: 'Cold damage' }] };
    const preview = await dispatchTool('batch_create', { ...args, dryRun: true }) as { commits: CommitResult[] };
    expect(preview.commits).toHaveLength(1);
    expect(await read('Skills.json')).toEqual([null]);
    await dispatchTool('batch_create', args);
    const row = (await read('Skills.json'))[1];
    expect(row.name).toBe('Frost');
    expect(row.messageType).toBeUndefined();
    expect(row.traits).toBeUndefined();
    expect(row.damage).toMatchObject({ type: 0, formula: '0' });
  });

  it('advertises unique strict schemas with previews only where supported', () => {
    expect(new Set(PARITY_TOOLS.map(tool => tool.name)).size).toBe(PARITY_TOOLS.length);
    for (const def of parityDefinitions) {
      const tool = PARITY_TOOLS.find(tool => tool.name === def.name)!;
      expect(tool.inputSchema.additionalProperties, def.name).toBe(false);
      if (def.mutates) expect(tool.inputSchema.properties, def.name).toHaveProperty('dryRun');
    }
  });
});

describe('conservative static analysis', () => {
  it('accounts for huge switch ranges without suggesting a used ID', async () => {
    await write('CommonEvents.json', [null, { id: 1, name: 'Range', trigger: 0, switchId: 0,
      list: [{ code: 121, indent: 0, parameters: [3, 1_000_000_000, 0] }, end] }]);
    expect(await listAllocatedIds(dir, 'switch', 900_000_000)).toMatchObject({ allocated: true, referenceCount: 1 });
    expect(await listAllocatedIds(dir, 'switch', 2)).toMatchObject({ allocated: false });
    expect(await nextFreeId(dir, 'switch', 2, true)).toMatchObject({ ids: [2], highest: 1_000_000_000 });
    expect(await nextFreeId(dir, 'switch')).toMatchObject({ ids: [] });
  });

  it.each(['1 2 +', 'Math.max(1 2)', 'Math.pow(2)', 'Math.abs(1,2)', 'a.constructor', 'Math.constructor(1)'])('refuses invalid grammar or inherited properties: %s', formula => {
    expect(evaluateFormula(formula, REFERENCE_CONTEXT).ok).toBe(false);
  });
});

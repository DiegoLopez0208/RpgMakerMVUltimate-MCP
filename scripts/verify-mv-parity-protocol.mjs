#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const end = { code: 0, indent: 0, parameters: [] };
const decode = result => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
};
async function snapshot(dir, prefix = '') {
  const files = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + item.name;
    if (item.isDirectory()) Object.assign(files, await snapshot(path.join(dir, item.name), rel + '/'));
    else files[rel] = (await readFile(path.join(dir, item.name))).toString('base64');
  }
  return files;
}

for (const legacy of ['0', '1']) {
  const project = await mkdtemp(path.join(tmpdir(), 'mv-parity-protocol-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
    env: { ...getDefaultEnvironment(), RPGMAKER_PROJECT_PATH: '', RPGMV_LEGACY_TOOLS: legacy } });
  const client = new Client({ name: 'mv-parity-verification', version: '1.0.0' });
  const call = async (name, args = {}) => decode(await client.callTool({ name, arguments: args }));
  try {
    await mkdir(path.join(project, 'data'));
    await mkdir(path.join(project, 'js'));
    for (const table of ['Actors','Classes','Skills','Items','Weapons','Armors','Enemies','Troops','States','Animations','CommonEvents']) {
      await writeFile(path.join(project, 'data', table + '.json'), '[null]');
    }
    await writeFile(path.join(project, 'data/System.json'), JSON.stringify({ gameTitle: 'Protocol', switches: ['', 'Door'], variables: ['', 'Count'], currencyUnit: 'G', partyMembers: [] }));
    await writeFile(path.join(project, 'data/MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Test', order: 1, parentId: 0 }]));
    await writeFile(path.join(project, 'data/Tilesets.json'), JSON.stringify([null, { id: 1, name: 'Empty', mode: 1, tilesetNames: Array(9).fill(''), flags: Array(8192).fill(0) }]));
    await writeFile(path.join(project, 'data/Map001.json'), JSON.stringify({ width: 4, height: 4, tilesetId: 1, data: Array(96).fill(0), encounterList: [], events: [null, { id: 1, name: 'Test', x: 1, y: 1, pages: [{ conditions: {}, image: { tileId: 0, characterName: '', characterIndex: 0, direction: 2, pattern: 1 }, trigger: 0, priorityType: 1, list: [end] }] }] }));
    await writeFile(path.join(project, 'js/plugins.js'), 'var $plugins = [];');
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    for (const name of ['build_change_gold','build_troop_page','get_tile_catalog','paint_blueprint','resize_map','batch_create','set_currency_unit','validate_assets','render_map','run_playtest','export_web','scan_plugins','analyze_project']) assert.ok(tools.find(t => t.name === name), name);
    for (const name of ['resize_map','batch_create','set_currency_unit','take_screenshot','record_video','export_web']) assert.ok(tools.find(t => t.name === name)?.inputSchema.properties.dryRun, name);
    const gold = await call('build_change_gold', { operation: 'increase', operand: { type: 'constant', value: 30 } });
    assert.ok(JSON.stringify(gold).includes('125'));
    await call('build_troop_page', { when: { turn: [1, 0] } });
    await call('set_project_path', { path: project });
    const before = await snapshot(project);
    for (const [name, args] of [
      ['resize_map', { mapId: 1, width: 6, height: 6 }],
      ['set_event_page', { mapId: 1, eventId: 1, pageIndex: 0, through: true }],
      ['paint_blueprint', { mapId: 1, rows: ['aa'], legend: { a: [[0, 2048]] } }],
      ['batch_create', { type: 'item', records: [{ name: 'Potion' }] }],
      ['set_currency_unit', { unit: 'Coins' }],
      ['manage_system', { action: 'create_plugin', name: 'Preview' }],
      ['manage_system', { action: 'mine_templates' }],
      ['manage_system', { action: 'bridge_start' }],
      ['take_screenshot', {}],
      ['record_video', { action: 'start' }],
    ]) assert.equal((await call(name, { ...args, dryRun: true })).dryRun, true, name);
    assert.deepEqual(await snapshot(project), before, 'previews must not create caches, backups, captures or plugins');
    for (const [name, args] of [
      ['get_map_region', { mapId: 1, x: 0, y: 0, width: 2, height: 2 }],
      ['get_tile_catalog', { tilesetId: 1 }], ['validate_references', {}],
      ['validate_assets', {}], ['scan_plugins', {}], ['next_free_id', { type: 'switch' }],
    ]) await call(name, args);
    await call('set_currency_unit', { unit: 'Coins' });
    assert.equal(JSON.parse(await readFile(path.join(project, 'data/System.json'), 'utf8')).currencyUnit, 'Coins');
    assert.equal((await client.callTool({ name: 'create_plugin_command', arguments: { text: 'bad\ncommand' } })).isError, true);
    assert.equal((await client.callTool({ name: 'batch_create', arguments: { type: 'actor', records: [{ name: 42 }] } })).isError, true);
    console.log(`PASS parity stdio ${legacy === '1' ? 'legacy' : 'default'}: ${tools.length} unique tools, all capability groups, pure builders, protected previews, commit and refusal`);
  } finally {
    await client.close();
    await transport.close();
    await rm(project, { recursive: true, force: true });
  }
}

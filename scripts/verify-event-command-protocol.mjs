import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
await access(entry);
const end = { code: 0, indent: 0, parameters: [] };
const decode = result => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
};

for (const legacy of ['0', '1']) {
  const project = await mkdtemp(path.join(tmpdir(), 'rpgmv-protocol-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], stderr: 'pipe',
    env: { ...getDefaultEnvironment(), RPGMAKER_PROJECT_PATH: '', RPGMV_LEGACY_TOOLS: legacy }
  });
  const client = new Client({ name: 'mv-event-command-verification', version: '1.0.0' });
  try {
    await mkdir(path.join(project, 'data'));
    await writeFile(path.join(project, 'data/System.json'), JSON.stringify({ gameTitle: 'Protocol fixture', switches: ['', 'Door'], variables: ['', 'Count'] }));
    const mapPath = path.join(project, 'data/Map001.json');
    await writeFile(mapPath, JSON.stringify({ width: 4, height: 4, data: [], events: [null, { id: 1, name: 'Protocol event', x: 1, y: 1, pages: [{ list: [end] }] }] }));
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['build_event_commands', 'insert_event_commands']) {
      assert.equal(tools.filter(t => t.name === name).length, 1);
    }
    assert.equal(tools.find(t => t.name === 'build_event_commands').annotations.readOnlyHint, true);
    // Pure builders must work before any project has been selected.
    const built = decode(await client.callTool({ name: 'build_event_commands', arguments: { kind: 'control_switch', scope: 'switch', switchId: '1', value: 'on' } }));
    assert.deepEqual(built.commands, [{ code: 121, indent: 0, parameters: [1, 1, 0] }]);
    assert.equal((await client.callTool({ name: 'get_project_context', arguments: { detail: 'summary' } })).isError, true);
    decode(await client.callTool({ name: 'set_project_path', arguments: { path: project } }));
    const before = await readFile(mapPath, 'utf8');
    const args = { mapId: '1', eventId: '1', commands: built.commands };
    const preview = decode(await client.callTool({ name: 'insert_event_commands', arguments: { ...args, dryRun: true } }));
    assert.equal(preview.dryRun, true);
    assert.equal(await readFile(mapPath, 'utf8'), before);
    await assert.rejects(access(mapPath + '.bak'));
    await assert.rejects(access(path.join(project, '.mcp-backups')));
    decode(await client.callTool({ name: 'insert_event_commands', arguments: args }));
    const committed = await readFile(mapPath, 'utf8');
    assert.deepEqual(JSON.parse(committed).events[1].pages[0].list, [...built.commands, end]);
    assert.equal((await client.callTool({ name: 'insert_event_commands', arguments: {
      ...args, commands: [{ code: 357, indent: 0, parameters: ['MZ', 'only', '', {}] }]
    } })).isError, true);
    assert.equal(await readFile(mapPath, 'utf8'), committed);
    console.log(`PASS MCP stdio ${legacy === '1' ? 'legacy + consolidated' : 'consolidated'}: discovery, project-free builder, selection, preview, commit, refusal`);
  } finally {
    await client.close();
    await transport.close();
    await rm(project, { recursive: true, force: true });
  }
}

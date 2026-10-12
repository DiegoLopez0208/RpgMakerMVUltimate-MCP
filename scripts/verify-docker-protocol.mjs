import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const image = process.argv[2] || 'rpgmaker-mv-mcp:docker-test';
const decode = result => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
};
const project = await mkdtemp(path.join(tmpdir(), 'rpgmv-docker-'));
const watchdog = setTimeout(() => {
  console.error('Docker MCP verification timed out');
  process.exit(1);
}, 90_000);
try {
  // Exercise the native dependency as well as the packaged knowledge files.
  execFileSync('docker', ['run', '--rm', image, 'node', '--input-type=module', '-e',
    "import sharp from 'sharp'; import { access } from 'node:fs/promises'; await access('dist/knowledge/map-templates.json'); const b = await sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer(); if (!b.length || process.getuid() === 0) process.exit(1); console.log('PASS native sharp, knowledge, non-root user');"
  ], { stdio: 'inherit', timeout: 30_000 });
  await mkdir(path.join(project, 'data'));
  await writeFile(path.join(project, 'data/System.json'), JSON.stringify({ gameTitle: 'Docker fixture', switches: ['', 'Door'], variables: ['', 'Count'] }));
  await writeFile(path.join(project, 'data/Map001.json'), JSON.stringify({ width: 4, height: 4, data: [], events: [null, { id: 1, name: 'Door', x: 1, y: 1, pages: [{ list: [{ code: 0, indent: 0, parameters: [] }] }] }] }));
  for (const mounted of [false, true]) {
    const transport = new StdioClientTransport({ command: 'docker', args: [
      'run', '--rm', '-i',
      // Linux bind mounts preserve UIDs; match the host for this writable fixture.
      ...(mounted && process.platform === 'linux' ? ['--user', `${process.getuid()}:${process.getgid()}`] : []),
      ...(mounted ? ['--mount', `type=bind,source=${project},target=/app/project`, '-e', 'RPGMAKER_PROJECT_PATH=/app/project'] : []),
      image
    ], stderr: 'pipe' });
    const client = new Client({ name: 'docker-verification', version: '1.0.0' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 18);
      const built = decode(await client.callTool({ name: 'build_event_commands', arguments: { kind: 'control_switch', scope: 'switch', switchId: '1', value: 'on' } }));
      assert.deepEqual(built.commands, [{ code: 121, indent: 0, parameters: [1, 1, 0] }]);
      const context = await client.callTool({ name: 'get_project_context', arguments: { detail: 'summary' } });
      if (mounted) {
        assert.equal(decode(context).gameTitle, 'Docker fixture');
        const templateResponse = await client.callTool({ name: 'get_project_context', arguments: { detail: 'templates' } });
        decode(templateResponse);
        const templates = JSON.parse(templateResponse.content.find(c => c.type === 'text').text);
        assert.ok(Array.isArray(templates) && templates.length > 0);
        decode(await client.callTool({ name: 'insert_event_commands', arguments: { mapId: '1', eventId: '1', commands: built.commands } }));
        const saved = JSON.parse(await readFile(path.join(project, 'data/Map001.json'), 'utf8'));
        assert.deepEqual(saved.events[1].pages[0].list[0], built.commands[0]);
      } else {
        assert.equal(context.isError, true);
      }
      console.log(`PASS Docker MCP: 18 tools, builder, ${mounted ? 'templates and mounted project read/write' : 'project-free discovery'}`);
    } catch (error) {
      console.error(diagnostics);
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
  }
} finally {
  clearTimeout(watchdog);
  await rm(project, { recursive: true, force: true });
}

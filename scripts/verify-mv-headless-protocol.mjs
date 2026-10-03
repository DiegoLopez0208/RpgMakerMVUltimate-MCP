// Optional: set RPGMAKER_MCP_TEST_PROJECT to a licensed disposable MV project.
// Set RPGMAKER_MCP_CHROMIUM to an installed Chrome/Edge executable if not cached.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { findChromium } from '../dist/parity/playtest/chromium.js';

const project = process.env.RPGMAKER_MCP_TEST_PROJECT;
assert.ok(project, 'Set RPGMAKER_MCP_TEST_PROJECT to a disposable licensed MV fixture.');
const chromium = findChromium();
const output = await mkdtemp(join(tmpdir(), 'mv-headless-protocol-'));
const protectedFiles = ['data/System.json', 'data/Map001.json', 'js/plugins.js'];
const originals = await Promise.all(protectedFiles.map((file) => readFile(join(project, file))));
const system = JSON.parse(originals[0].toString('utf8'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: {
    ...getDefaultEnvironment(),
    RPGMAKER_PROJECT_PATH: project,
    RPGMAKER_MCP_CHROMIUM: chromium,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'headless-protocol-verification', version: '1.0.0' });
const progress = [];
let errors = '';

async function verifyImage(result, expectedPath) {
  assert.ok(!result.isError, JSON.stringify(result.content));
  const images = result.content.filter((item) => item.type === 'image');
  assert.equal(images.length, 1, 'inline:true must preserve native image content through stdio.');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(result._meta.imageDelivery.attached, 1);
  assert.equal(result._meta.imageDelivery.truncated, false);
  const decoded = Buffer.from(images[0].data, 'base64');
  assert.deepEqual(decoded, await readFile(expectedPath));
  return decoded.length;
}

try {
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => {
    errors += chunk.toString();
  });
  const render = await client.callTool({
    name: 'render_map',
    arguments: { mapId: system.startMapId, out: output, inline: true },
  });
  assert.ok(!render.isError, JSON.stringify(render.content));
  const rendered = JSON.parse(render.content.find((item) => item.type === 'text').text);
  const renderBytes = await verifyImage(render, rendered.path);
  assert.equal(rendered.mode, 'whole_map');
  assert.deepEqual(render.structuredContent, rendered, 'MV structured content remains available beside PNGs.');

  const play = await client.callTool(
    {
      name: 'run_playtest',
      arguments: {
        inline: true,
        out: output,
        steps: [
          { action: 'load', mapId: system.startMapId, x: system.startX, y: system.startY },
          { action: 'eval', script: '$gameMap.mapId()' },
          { action: 'wait', ms: 5500 },
          { action: 'screenshot', name: 'protocol' },
        ],
      },
    },
    undefined,
    { timeout: 30000, resetTimeoutOnProgress: true, onprogress: (value) => progress.push(value) },
  );
  assert.ok(!play.isError, JSON.stringify(play.content));
  const played = JSON.parse(play.content.find((item) => item.type === 'text').text);
  assert.equal(played.ok, true);
  assert.equal(played.steps[1].value, system.startMapId);
  assert.equal(played.screenshots.length, 1);
  const playBytes = await verifyImage(play, played.screenshots[0]);
  assert.ok(progress.length >= 6, 'Expected boot, step, and completion progress notifications.');
  assert.ok(
    progress.some((value) => !Number.isInteger(value.progress)),
    'Expected a heartbeat during the wait step.',
  );
  for (let index = 1; index < progress.length; index++)
    assert.ok(progress[index].progress > progress[index - 1].progress);
  assert.equal(progress.at(-1).progress, progress.at(-1).total);
  assert.equal(progress.at(-1).message, 'Done');
  let reachedEval;
  const evaluating = new Promise((resolve) => { reachedEval = resolve; });
  const hanging = client.callTool({
    name: 'run_playtest',
    arguments: { steps: [
      { action: 'load', mapId: system.startMapId, x: system.startX, y: system.startY },
      { action: 'eval', script: 'new Promise(() => {})' },
    ] },
  }, undefined, {
    timeout: 30000,
    onprogress: (value) => { if (value.message?.includes(': eval')) reachedEval(); },
  }).catch(() => undefined);
  await Promise.race([evaluating, delay(25000, undefined, { ref: false }).then(() => { throw new Error('Cancellation probe never reached eval'); })]);
  await delay(100);
  const closeStarted = Date.now();
  await client.close();
  const eofShutdownMs = Date.now() - closeStarted;
  // SDK transport.close waits two seconds before resorting to SIGTERM. Finishing
  // sooner proves stdin EOF itself cancelled the owned browser/tool work.
  assert.ok(eofShutdownMs < 1900, `EOF cleanup took ${eofShutdownMs}ms and may have required a forced signal.`);
  await hanging;
  for (let index = 0; index < protectedFiles.length; index++)
    assert.deepEqual(await readFile(join(project, protectedFiles[index])), originals[index]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        renderImageBytes: renderBytes,
        playtestImageBytes: playBytes,
        progressNotifications: progress.length,
        heartbeat: true,
        eofCancelledPendingEval: true,
        eofShutdownMs,
        projectFilesUnchanged: true,
        renderProblems: rendered.problems,
        playtestProblems: played.problems,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (errors) console.error(errors);
  throw error;
} finally {
  await client.close();
  await rm(output, { recursive: true, force: true });
}

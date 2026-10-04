import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), close: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launch: mocks.launch } }));
vi.mock('../src/playtest/chromium.js', () => ({ findChromium: () => '/synthetic/chromium' }));
import { openSession, stopHeadlessSessions } from '../src/playtest/session.js';
import { runPlaytest } from '../src/playtest/playtest.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mv-headless-cancel-'));
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.launch.mockReset();
});
afterEach(async () => {
  await stopHeadlessSessions();
  await rm(root, { recursive: true, force: true });
});

// playwright-core's supported runtime starts at Node 20; the core MCP still
// supports Node 18, where this optional feature returns a requirements error.
describe.skipIf(Number(process.versions.node.split('.')[0]) < 20)('headless shutdown cancellation without a real browser', () => {
  it('interrupts a never-resolving evaluation and closes the owned browser exactly once', async () => {
    let evaluating!: () => void;
    const reachedEval = new Promise<void>((resolve) => { evaluating = resolve; });
    const page = {
      on: vi.fn(), addInitScript: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined), waitForFunction: vi.fn().mockResolvedValue(undefined),
      evaluate: (script: string) => {
        if (script === 'new Promise(() => {})') {
          evaluating();
          // Browser-close mock deliberately does not resolve this: cancellation
          // must end the tool independently of page JavaScript cooperativeness.
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve(true);
      },
    };
    mocks.launch.mockResolvedValue({ newPage: async () => page, close: mocks.close });
    const running = runPlaytest(root, [
      { action: 'load', mapId: 1, x: 0, y: 0 },
      { action: 'eval', script: 'new Promise(() => {})' },
    ], { out: root });
    await reachedEval;
    await stopHeadlessSessions();
    expect(await running).toMatchObject({ ok: false, failedStep: 1, error: expect.stringContaining('cancelled') });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('cancels startup and closes a browser that finishes launching after cancellation', async () => {
    let launching!: () => void;
    const reachedLaunch = new Promise<void>((resolve) => { launching = resolve; });
    let finishLaunch!: (browser: { close: typeof mocks.close }) => void;
    mocks.launch.mockImplementation(() => {
      launching();
      return new Promise((resolve) => { finishLaunch = resolve; });
    });
    const opening = openSession(root);
    const rejected = expect(opening).rejects.toThrow(/cancelled/);
    await reachedLaunch;
    await stopHeadlessSessions();
    await rejected;
    finishLaunch({ close: mocks.close });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, afterAll, beforeAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  resolveRequestPath,
  startStaticServer,
  StaticServer,
} from '../src/playtest/staticServer.js';
import { planRender, MAX_RENDER_EDGE_PX } from '../src/playtest/render.js';
import { checkSteps, playtestSteps } from '../src/playtest/steps.js';
import { driverCall } from '../src/playtest/session.js';
import { safeName } from '../src/playtest/output.js';
import { battleSpeedFor, BATTLE_SPEED, progressTicker } from '../src/playtest/playtest.js';
import { stripControlCodes } from '../src/playtest/text.js';
import { runInNewContext } from 'vm';
import { ENGINE_DRIVER } from '../src/playtest/driver.js';

describe('MV-specific headless engine seams', () => {
  it('uses MV choice windows and resizes MV Graphics without MZ APIs', () => {
    let selected = -1;
    const choice = { active: true, select(index: number) { selected = index; } };
    const graphics = { width: 816, height: 624, boxWidth: 816, boxHeight: 624 };
    const manager = { _scene: { _messageWindow: { _choiceWindow: choice } } };
    const window: { __mcp?: { choiceOpen(): boolean; selectChoice(index: number): void; resizeToMap(w: number, h: number): void } } = {};
    runInNewContext(ENGINE_DRIVER, { window, SceneManager: manager, Graphics: graphics });
    expect(window.__mcp!.choiceOpen()).toBe(true);
    window.__mcp!.selectChoice(1);
    expect(selected).toBe(1);
    window.__mcp!.resizeToMap(1008, 720);
    expect(graphics).toEqual({ width: 1008, height: 720, boxWidth: 1008, boxHeight: 720 });
  });

  it('fast-forwards scene logic without multiplying MV requestAnimationFrame schedulers', () => {
    class Battle {}
    let updates = 0;
    const updateMain = () => undefined;
    const manager = { _scene: new Battle(), updateMain, updateScene: () => { updates++; }, isSceneChanging: () => false };
    const gameMessage = { prototype: { add: () => undefined, setChoices: () => undefined } };
    const window: { Game_Message: unknown; __mcp?: { init(): void; setBattleSpeed(n: number): void } } = { Game_Message: gameMessage };
    runInNewContext(ENGINE_DRIVER, {
      window, SceneManager: manager, Scene_Battle: Battle, Game_Message: gameMessage,
      Game_Player: { prototype: { performTransfer: () => undefined } }, AudioManager: {},
      ConfigManager: {}, ImageManager: {}, Bitmap: { prototype: { isReady: () => true } },
    });
    window.__mcp!.init();
    window.__mcp!.setBattleSpeed(4);
    manager.updateScene();
    expect(updates).toBe(4);
    expect(manager.updateMain).toBe(updateMain);
  });
});

describe('resolveRequestPath', () => {
  const root = resolve('/proj');
  it('maps URLs under the root and serves index.html for /', () => {
    expect(resolveRequestPath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveRequestPath(root, '/img/characters/Actor1.png?x=1')).toBe(
      join(root, 'img', 'characters', 'Actor1.png'),
    );
    expect(resolveRequestPath(root, '/img/%21Chest.png')).toBe(join(root, 'img', '!Chest.png'));
  });

  it('refuses traversal out of the root', () => {
    expect(resolveRequestPath(root, '/../secret')).toBeNull();
    expect(resolveRequestPath(root, '/%2e%2e/secret')).toBeNull();
    expect(resolveRequestPath(root, '/img/../../x')).toBeNull();
    expect(resolveRequestPath(root, '/%E0%A4%A')).toBeNull(); // malformed escape
  });
});

describe('startStaticServer', () => {
  let dir: string;
  let server: StaticServer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rmmv-static-'));
    await mkdir(join(dir, 'data'));
    await writeFile(join(dir, 'data', 'System.json'), '{"a":1}');
    server = await startStaticServer(dir);
  });
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves project files with a content type, and 404s missing ones', async () => {
    const ok = await fetch(`${server.origin}/data/System.json`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/application\/json/);
    expect(await ok.json()).toEqual({ a: 1 });
    expect((await fetch(`${server.origin}/img/missing.png`)).status).toBe(404);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('planRender', () => {
  it('renders the whole map by default, player hidden', () => {
    expect(planRender({ width: 17, height: 13 }, {})).toEqual({
      mode: 'whole_map',
      x: 0,
      y: 0,
      viewport: { width: 816, height: 624 },
      showPlayer: false,
    });
  });

  it('renders a centred view when x and y are given', () => {
    const plan = planRender({ width: 40, height: 40 }, { x: 10, y: 12 });
    expect(plan).toMatchObject({ mode: 'view', x: 10, y: 12, showPlayer: true });
    expect(plan.viewport).toEqual({ width: 816, height: 624 });
  });

  it('rejects half a coordinate, out-of-map tiles and oversize maps', () => {
    expect(() => planRender({ width: 10, height: 10 }, { x: 1 })).toThrow(/both x and y/);
    expect(() => planRender({ width: 10, height: 10 }, { x: 10, y: 0 })).toThrow(/outside/);
    const edge = Math.floor(MAX_RENDER_EDGE_PX / 48) + 1;
    expect(() => planRender({ width: edge, height: 5 }, {})).toThrow(/Pass x and y/);
    // …but a view of an oversize map is fine.
    expect(planRender({ width: edge, height: 5 }, { x: 0, y: 0 }).mode).toBe('view');
  });
});

describe('playtest steps', () => {
  it('parses a typical script', () => {
    const steps = playtestSteps.parse([
      { action: 'load', mapId: 2, x: 6, y: 6, switches: [12], items: [{ id: 1 }] },
      { action: 'startEvent', eventId: 1 },
      { action: 'advanceText' },
      { action: 'choose', index: 1 },
      { action: 'walk', direction: 'left', steps: 3 },
      { action: 'autoBattle', troopId: 4 },
      { action: 'screenshot', name: 'end' },
      { action: 'eval', script: '$gameSwitches.value(3)' },
    ]);
    expect(steps).toHaveLength(8);
    expect(checkSteps(steps)).toEqual([]);
  });

  it('rejects unknown actions, bad fields and empty scripts', () => {
    expect(playtestSteps.safeParse([{ action: 'fly' }]).success).toBe(false);
    expect(playtestSteps.safeParse([{ action: 'walk', direction: 'north' }]).success).toBe(false);
    expect(playtestSteps.safeParse([{ action: 'choose', index: -1 }]).success).toBe(false);
    expect(playtestSteps.safeParse([]).success).toBe(false);
  });

  it('flags map actions that run before any load', () => {
    const steps = playtestSteps.parse([
      { action: 'walk', direction: 'up' },
      { action: 'eval', script: '  ' },
    ]);
    const problems = checkSteps(steps);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/steps\[0\] \(walk\) runs before any "load"/);
    expect(problems[1]).toMatch(/steps\[1\] \(eval\) has an empty script/);
  });
});

describe('driver helpers', () => {
  it('builds JSON-argument driver calls and refuses odd names', () => {
    expect(driverCall('load', [{ mapId: 1, n: 'a"b' }])).toBe(
      '__mcp.load({"mapId":1,"n":"a\\"b"})',
    );
    expect(driverCall('busy', [])).toBe('__mcp.busy()');
    expect(() => driverCall('x); alert(1', [])).toThrow(/Bad driver function/);
  });

  it('sanitizes screenshot names', () => {
    expect(safeName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeName('after battle.png')).toBe('after_battle');
    expect(safeName('...')).toBe('shot');
  });

});

describe('progressTicker', () => {
  it('reports each phase and strictly increasing heartbeats below the next phase', () => {
    vi.useFakeTimers();
    try {
      const seen: Array<[number, number, string]> = [];
      const t = progressTicker((p, total, msg) => seen.push([p, total, msg]), 3);
      t.phase(0, 'Booting the game');
      t.phase(1, 'Step 1/2: autoBattle');
      vi.advanceTimersByTime(15000);
      t.phase(2, 'Step 2/2: eval');
      t.stop();
      vi.advanceTimersByTime(15000);
      expect(seen.map(([p]) => p)).toEqual([0, 1, 1.5, 1 + 2 / 3, 1.75, 2]);
      expect(seen.every(([, total]) => total === 3)).toBe(true);
      expect(seen[2][2]).toBe('Step 1/2: autoBattle (5s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op without a sink', () => {
    const t = progressTicker(undefined, 2);
    expect(() => {
      t.phase(1, 'x');
      t.stop();
    }).not.toThrow();
  });
});

describe('stripControlCodes', () => {
  // Input is what the engine's convertEscapeCharacters leaves: \V/\N/\P/\G
  // already expanded, \\ already a lone backslash, other codes ESC-prefixed.
  const esc = (s: string) => s.replace(/~/g, '\x1b');

  it('drops the wait/instant/input codes the victory text carries', () => {
    expect(stripControlCodes(esc('~.92 EXP received!'))).toBe('92 EXP received!');
    expect(stripControlCodes(esc('~.320G found!'))).toBe('320G found!');
    expect(stripControlCodes(esc('a~|b~!c~>d~<e~^f~$'))).toBe('abcdef');
  });

  it('drops codes with parameters, font-size braces and plugin codes', () => {
    expect(stripControlCodes(esc('~C[2]red~C[0] ~I[64]Potion'))).toBe('red Potion');
    expect(stripControlCodes(esc('~{BIG~} ~FS[30]x~PX[4]y~PY[2]'))).toBe('BIG xy');
    expect(stripControlCodes(esc('~MSG[left]hi'))).toBe('hi');
  });

  it('keeps literal backslashes, brackets and plain text', () => {
    expect(stripControlCodes('a\\b [note] 50%')).toBe('a\\b [note] 50%');
    expect(stripControlCodes('Kael has 42 G!')).toBe('Kael has 42 G!');
    expect(stripControlCodes(esc('stray ~'))).toBe('stray ');
  });
});

describe('run_playtest options', () => {
  it('fast-forwards battles unless realtime is set', () => {
    expect(BATTLE_SPEED).toBeGreaterThan(1);
    expect(battleSpeedFor({})).toBe(BATTLE_SPEED);
    expect(battleSpeedFor({ realtime: false })).toBe(BATTLE_SPEED);
    expect(battleSpeedFor({ realtime: true })).toBe(1);
  });
});

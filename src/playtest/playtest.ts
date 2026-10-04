import { dirname, join } from 'path';
import { EngineSession, openSession } from './session.js';
import { resolvePngPath, safeName, stamp } from './output.js';
import { checkSteps, DIRECTION_CODE, LoadStep, PlaytestStep } from './steps.js';
import { stripControlCodes } from './text.js';

/**
 * `run_playtest`: execute a scripted play session headless and report what
 * happened step by step — the text the game showed, where the player ended up,
 * battle outcomes, screenshots — plus every console/page/HTTP problem.
 */

export interface StepResult {
  index: number;
  action: PlaytestStep['action'];
  ok: boolean;
  [detail: string]: unknown;
}

export interface PlaytestResult {
  ok: boolean;
  /** Index of the step that failed, when one did. Later steps were not run. */
  failedStep?: number;
  error?: string;
  steps: StepResult[];
  screenshots: string[];
  /** Where the game stood after the last step that ran. */
  finalState?: unknown;
  problems: string[];
}

interface TextLog {
  /** Lines shown on the map (event dialogue). */
  lines: string[];
  /** Lines shown during a battle (troop battle events, victory/defeat messages). */
  battleLines?: string[];
  choices: string[] | null;
}

/**
 * Read the page's message log (`takeText` or `peekText`) as the player saw it,
 * with the message window's control codes stripped.
 */
async function readText(s: EngineSession, fn: 'takeText' | 'peekText'): Promise<TextLog> {
  const t = await s.call<TextLog>(fn);
  const clean = (lines: string[]) => lines.map(stripControlCodes);
  return {
    lines: clean(t.lines),
    ...(t.battleLines ? { battleLines: clean(t.battleLines) } : {}),
    choices: t.choices ? clean(t.choices) : null,
  };
}

/**
 * Default `autoBattle.maxMs`. Kept under the MCP SDK's 60 s request timeout;
 * with battles fast-forwarded that fits a multi-turn boss fight.
 */
export const AUTO_BATTLE_MAX_MS = 60000;

/**
 * Engine frames run per animation frame while a battle is on screen, unless the
 * run asks for `realtime`. A 10-turn boss fight that takes ~70 s in real time
 * finishes in ~4 s; going higher gains little, since what's left is the
 * victory messages waiting for OK presses.
 */
export const BATTLE_SPEED = 20;

/** The battle frame multiplier for a run's options (1 = real time). */
export function battleSpeedFor(opts: { realtime?: boolean }): number {
  return opts.realtime ? 1 : BATTLE_SPEED;
}

/** How often a long step sends a progress heartbeat (when the client asked for progress). */
const HEARTBEAT_MS = 5000;

/** Longest `walk`/`startEvent` waits for an event it set off to reach a resting point. */
const SETTLE_MS = 5000;

interface Flow {
  scene: string | null;
  changing: boolean;
  transferring: boolean;
  mapReady: boolean;
  message: boolean;
  eventRunning: boolean;
}

interface Tile {
  mapId: number;
  x: number;
  y: number;
}

type StepFn<S extends PlaytestStep> = (
  s: EngineSession,
  step: S,
  ctx: { index: number; outDir: string; runId: string; screenshots: string[] },
) => Promise<Record<string, unknown>>;

const doLoad: StepFn<LoadStep> = async (s, step) => {
  // Calling setupNewGame under a live Scene_Map nulls the tileset beneath the
  // spriteset — go back to the title first.
  await s.call('leaveMap');
  await s.waitFor('the title screen', 'idleOffMap');
  await s.call('load', {
    ...step,
    direction: step.direction ? DIRECTION_CODE[step.direction] : 2,
  });
  await s.waitFor(`map ${step.mapId} to load`, 'mapReady');
  return { state: await s.call('state') };
};

/**
 * Refuse to start something while an event/message is still running — the
 * engine would silently queue it behind the running event (a new battle scene
 * never opens while a message window is up), and the step would time out with
 * no clue why. Typically a map's autorun cutscene is still going after `load`.
 */
async function assertIdle(s: EngineSession, what: string): Promise<void> {
  if (await s.call<boolean>('busy')) {
    const text = await readText(s, 'peekText');
    const last = text.lines.slice(-2).join(' / ');
    throw new Error(
      `Can't ${what}: an event or message is still running${last ? ` (last text: "${last}")` : ''}. ` +
        'Add an advanceText step first (a map autorun event may be playing after load).',
    );
  }
}

async function advanceText(s: EngineSession, maxMs: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let stoppedAt: 'idle' | 'choice' | 'battle' | 'title' | 'timeout' = 'timeout';
  while (Date.now() - t0 < maxMs) {
    if (await s.call<boolean>('choiceOpen')) {
      stoppedAt = 'choice';
      break;
    }
    const scene = await s.call<string>('sceneName');
    if (scene === 'Scene_Battle') {
      stoppedAt = 'battle';
      break;
    }
    if (scene === 'Scene_Title' || scene === 'Scene_Gameover') {
      stoppedAt = 'title';
      break;
    }
    if (!(await s.call<boolean>('busy'))) {
      // One more look after a beat: an event may be between commands.
      await s.page.waitForTimeout(250);
      if (!(await s.call<boolean>('busy'))) {
        stoppedAt = 'idle';
        break;
      }
    }
    await s.press('ok');
    await s.page.waitForTimeout(90);
  }
  const text = await readText(s, 'takeText');
  return {
    stoppedAt,
    lines: text.lines,
    ...(text.battleLines ? { battleLines: text.battleLines } : {}),
    ...(text.choices ? { choices: text.choices } : {}),
  };
}

async function choose(s: EngineSession, index: number): Promise<Record<string, unknown>> {
  await s.waitFor('a choice list to open', 'choiceOpen', [], 10000);
  const count = await s.call<number>('choiceCount');
  if (index >= count) throw new Error(`Choice ${index} is out of range — the list has ${count}.`);
  await s.call('selectChoice', index);
  await s.page.waitForTimeout(60);
  await s.press('ok');
  await s.page.waitForTimeout(150);
  return { chosen: index };
}

interface Pos {
  mapId: number;
  x: number;
  y: number;
  moving: boolean;
}

/** Tile offset of one step in each direction (engine y grows downward). */
const STEP_DELTA = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
} as const;

/**
 * After something may have set off an event (a touch trigger, `startEvent`),
 * let it run to a resting point: wait through a player transfer — the fade, the
 * scene change and the new map loading — and through event commands that show
 * nothing (waits, move routes, the frames before a Transfer Player runs). Stops
 * as soon as there is something for the script to handle (a message, a choice,
 * a battle) or nothing is running, and gives up quietly after `SETTLE_MS` (a
 * long silent cutscene is reported as `eventRunning`, not as an error).
 */
async function settle(s: EngineSession): Promise<void> {
  const t0 = Date.now();
  let idleSince: number | undefined;
  while (Date.now() - t0 < SETTLE_MS) {
    const f = await s.call<Flow>('flow');
    if (f.scene === 'Scene_Battle' || f.scene === 'Scene_Gameover' || f.message) return;
    const moving = f.changing || f.transferring || (f.scene === 'Scene_Map' && !f.mapReady);
    if (moving || f.eventRunning) {
      idleSince = undefined;
    } else {
      // Idle — confirm over a short beat, since an event can be between commands.
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 200) return;
    }
    await s.page.waitForTimeout(50);
  }
}

/** Where the player was transferred to since the last `clearTransfer`, if anywhere. */
async function takeTransfer(s: EngineSession): Promise<{ transferredTo?: Tile }> {
  const t = await s.call<Tile | null>('takeTransfer');
  return t ? { transferredTo: t } : {};
}

/** Whether an event/message is still going after settling — the script's cue to advanceText. */
async function runningFlags(s: EngineSession): Promise<Record<string, unknown>> {
  const f = await s.call<Flow>('flow');
  return {
    ...(f.message ? { messageOpen: true } : {}),
    ...(f.message || f.eventRunning || f.scene === 'Scene_Battle' ? { eventRunning: true } : {}),
    ...(f.scene !== 'Scene_Map' ? { scene: f.scene } : {}),
  };
}

async function startEvent(s: EngineSession, eventId: number): Promise<Record<string, unknown>> {
  await assertIdle(s, `start event ${eventId}`);
  const event = await s.call('startEvent', eventId);
  await settle(s);
  return { event, ...(await takeTransfer(s)), ...(await runningFlags(s)) };
}

/**
 * Walk tile by tile: hold the direction until the player leaves the tile (or a
 * timeout says it's blocked), then release and let the move finish. Reports
 * where it stopped and, when a tile refused entry, both the player's tile
 * (`stoppedAt`) and the refused one (`blockedTile`) — the invisible-wall check.
 * When a step sets off an event (a door, a touch trigger) the walk stops, waits
 * for any transfer to finish, and reports the arrival as `transferredTo`.
 */
async function walk(
  s: EngineSession,
  dir: keyof typeof DIRECTION_CODE,
  steps: number,
): Promise<Record<string, unknown>> {
  const start = await s.call<Pos>('playerPos');
  await s.call('clearTransfer');
  let walked = 0;
  let blocked: { stoppedAt: Tile; blockedTile: Tile } | undefined;
  for (let i = 0; i < steps; i++) {
    const before = await s.call<Pos>('playerPos');
    await s.page.evaluate(`Input._currentState[${JSON.stringify(dir)}] = true`);
    let moved = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
      const p = await s.call<Pos>('playerPos');
      if (p.moving || p.x !== before.x || p.y !== before.y || p.mapId !== before.mapId) {
        moved = true;
        break;
      }
      await s.page.waitForTimeout(30);
    }
    await s.page.evaluate(`Input._currentState[${JSON.stringify(dir)}] = false`);
    if (!moved) {
      // Bumping into a same-as-characters touch event starts it without moving
      // the player: that's a trigger, not a wall.
      if (await s.call<boolean>('busy')) {
        await settle(s);
        break;
      }
      const { dx, dy } = STEP_DELTA[dir];
      blocked = {
        stoppedAt: { mapId: before.mapId, x: before.x, y: before.y },
        blockedTile: { mapId: before.mapId, x: before.x + dx, y: before.y + dy },
      };
      break;
    }
    // Let the step finish.
    const t1 = Date.now();
    while (Date.now() - t1 < 2000) {
      const p = await s.call<Pos>('playerPos');
      if (!p.moving) break;
      await s.page.waitForTimeout(30);
    }
    walked++;
    if (await s.call<boolean>('busy')) {
      // An event fired — let any transfer land, then stop and let the script handle it.
      await settle(s);
      break;
    }
  }
  const end = await s.call<Pos>('playerPos');
  return {
    requested: steps,
    walked,
    from: { mapId: start.mapId, x: start.x, y: start.y },
    to: { mapId: end.mapId, x: end.x, y: end.y },
    ...(blocked ?? {}),
    ...(await takeTransfer(s)),
    ...(await runningFlags(s)),
  };
}

async function autoBattle(
  s: EngineSession,
  step: Extract<PlaytestStep, { action: 'autoBattle' }>,
): Promise<Record<string, unknown>> {
  if (step.troopId !== undefined) {
    await assertIdle(s, 'start a battle');
    await s.call('startBattle', step.troopId, step.canEscape ?? false, step.canLose ?? false);
  }
  await s.waitFor('a battle to start', 'sceneIs', ['Scene_Battle'], 15000);
  await s.call('setAutoBattle');
  const maxMs = step.maxMs ?? AUTO_BATTLE_MAX_MS;
  const t0 = Date.now();
  let last: unknown;
  let ended = false;
  while (Date.now() - t0 < maxMs) {
    if ((await s.call<string>('sceneName')) !== 'Scene_Battle') {
      ended = true;
      break;
    }
    last = await s.call('battleSnapshot');
    await s.press('ok');
    await s.page.waitForTimeout(200);
  }
  if (!ended) throw new Error(`Battle still running after ${maxMs}ms.`);
  // Let the victory/defeat transition settle before reading the result.
  await s.page.waitForTimeout(300);
  // The battle's own messages (troop battle events, victory/defeat text), taken
  // here so a later advanceText reports only what the map says afterwards.
  const text = await readText(s, 'takeText');
  const battleLines = [...(text.battleLines ?? []), ...text.lines];
  return {
    outcome: await s.call('battleOutcome'),
    final: await s.call('battleSnapshot'),
    turnsSeen: (last as { turn?: number } | undefined)?.turn ?? 0,
    scene: await s.call('sceneName'),
    ...(battleLines.length ? { lines: battleLines } : {}),
  };
}

async function runStep(
  s: EngineSession,
  step: PlaytestStep,
  ctx: { index: number; outDir: string; runId: string; screenshots: string[] },
): Promise<Record<string, unknown>> {
  switch (step.action) {
    case 'load':
      return doLoad(s, step, ctx);
    case 'startEvent':
      return startEvent(s, step.eventId);
    case 'advanceText':
      return advanceText(s, step.maxMs ?? 15000);
    case 'choose':
      return choose(s, step.index);
    case 'walk':
      return walk(s, step.direction, step.steps ?? 1);
    case 'press':
      for (let i = 0; i < (step.times ?? 1); i++) await s.press(step.button);
      return {};
    case 'wait':
      await s.page.waitForTimeout(step.ms);
      return {};
    case 'autoBattle':
      return autoBattle(s, step);
    case 'screenshot': {
      const name = safeName(step.name ?? `step${ctx.index}`);
      const path = join(ctx.outDir, `${ctx.runId}_${name}.png`);
      await s.page.screenshot({ path });
      ctx.screenshots.push(path);
      return { path };
    }
    case 'eval': {
      const value = await s.evaluate(step.script);
      return { value: value === undefined ? null : value };
    }
  }
}

/**
 * Progress reporting for a run: `phase` announces a new unit of work (whole
 * numbers), and a heartbeat every `HEARTBEAT_MS` while it runs (booting, a
 * minute-long battle) keeps a client that resets its timeout on progress from
 * giving up. Progress must strictly increase, so heartbeats creep towards the
 * next whole number without reaching it. A no-op without a sink.
 */
export function progressTicker(
  report: ((progress: number, total: number, message: string) => void) | undefined,
  total: number,
): { phase: (n: number, label: string) => void; stop: () => void } {
  if (!report) return { phase: () => undefined, stop: () => undefined };
  let base = 0;
  let label = '';
  let beats = 0;
  let since = Date.now();
  const timer = setInterval(() => {
    beats++;
    const secs = Math.round((Date.now() - since) / 1000);
    report(base + beats / (beats + 1), total, `${label} (${secs}s)`);
  }, HEARTBEAT_MS);
  return {
    phase: (n, l) => {
      base = n;
      label = l;
      beats = 0;
      since = Date.now();
      report(n, total, l);
    },
    stop: () => clearInterval(timer),
  };
}

export async function runPlaytest(
  projectPath: string,
  steps: PlaytestStep[],
  opts: {
    out?: string;
    /** Progress sink (MCP progress notifications): called per step and as a heartbeat during long ones. */
    onProgress?: (progress: number, total: number, message: string) => void;
    /** Play battles at real-time speed instead of fast-forwarding them (`BATTLE_SPEED`). */
    realtime?: boolean;
  } = {},
): Promise<PlaytestResult> {
  const preflight = checkSteps(steps);
  if (preflight.length) throw new Error(`Invalid playtest script: ${preflight.join(' ')}`);

  const runId = `playtest_${stamp()}`;
  // resolvePngPath creates the directory; screenshots go next to its file name.
  const outDir = dirname(await resolvePngPath(opts.out, `${runId}.png`));
  const screenshots: string[] = [];
  const results: StepResult[] = [];

  // Booting the game counts as one unit of progress, then one per step.
  const progress = progressTicker(opts.onProgress, steps.length + 1);
  try {
    progress.phase(0, 'Booting the game');
    const session = await openSession(projectPath);
    try {
      await session.call('setBattleSpeed', battleSpeedFor(opts));
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        progress.phase(index + 1, `Step ${index + 1}/${steps.length}: ${step.action}`);
        try {
          const detail = await runStep(session, step, { index, outDir, runId, screenshots });
          results.push({ index, action: step.action, ok: true, ...detail });
        } catch (e) {
          const error = e instanceof Error ? e.message.split('\n')[0] : String(e);
          results.push({ index, action: step.action, ok: false, error });
          return {
            ok: false,
            failedStep: index,
            error,
            steps: results,
            screenshots,
            finalState: await session.call('state').catch(() => undefined),
            problems: [...session.problems],
          };
        }
      }
      progress.phase(steps.length + 1, 'Done');
      return {
        ok: true,
        steps: results,
        screenshots,
        finalState: await session.call('state'),
        problems: [...session.problems],
      };
    } finally {
      await session.close();
    }
  } finally {
    progress.stop();
  }
}

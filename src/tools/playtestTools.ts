/**
 * playtestTools.ts — headless, in-engine verification.
 *
 * Both tools boot the project's own index.html in a cached Chromium through the
 * optional playwright-core dependency (see src/playtest/), so they need no
 * editor, no NW.js and no running game. They never change project data; the
 * PNGs they produce go under <project>/.mcp-cache/renders, next to the live
 * bridge's screenshots and recordings, never to a caller-chosen path.
 *
 * Ported from PR #20; the arbitrary `out` path and the separate render_map tool
 * were dropped (rendering is a mode of take_screenshot).
 */
import { z } from 'zod';
import { projectFile } from '../bridge/projectPaths.js';
import { renderMap } from '../playtest/render.js';
import { runPlaytest } from '../playtest/playtest.js';
import { playtestSteps } from '../playtest/steps.js';

export type ProgressSink = (progress: number, total: number, message: string) => void;

const whole = (min: number) => z.preprocess(
  (value) => (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
  z.number().int().min(min),
);

const renderArgs = z.object({
  mapId: whole(1),
  x: whole(0).optional(),
  y: whole(0).optional(),
  showEvents: z.boolean().optional(),
  showPlayer: z.boolean().optional(),
  switches: z.array(whole(1)).optional(),
  runEvents: z.boolean().optional(),
}).strict();

const playtestArgs = z.object({
  steps: playtestSteps,
  realtime: z.boolean().optional(),
}).strict();

/** Where headless PNGs go: inside the project, symlink-safe. */
async function rendersDir(projectPath: string): Promise<string> {
  return projectFile(projectPath, '.mcp-cache', 'renders');
}

/** take_screenshot with a mapId: the map as the engine draws it, without a running game. */
export async function renderMapScreenshot(projectPath: string, input: Record<string, unknown>) {
  const args = renderArgs.parse(input);
  return renderMap(projectPath, { ...args, out: await rendersDir(projectPath) });
}

/** run_playtest: play a script of steps headless and report what happened. */
export async function runPlaytestScript(projectPath: string, input: Record<string, unknown>, onProgress?: ProgressSink) {
  const args = playtestArgs.parse(input);
  return runPlaytest(projectPath, args.steps, { out: await rendersDir(projectPath), onProgress, realtime: args.realtime });
}

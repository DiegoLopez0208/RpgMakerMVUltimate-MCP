import { z } from 'zod';
import { ToolDefinition } from '../registry.js';
import { renderMap, RenderMapResult } from '../playtest/render.js';
import { runPlaytest, PlaytestResult } from '../playtest/playtest.js';
import { playtestSteps, MAX_STEPS } from '../playtest/steps.js';

/**
 * Headless in-engine verification (issue #13): `render_map` screenshots a map
 * the way the game draws it, `run_playtest` drives a scripted session. Both boot
 * the project's own `index.html` in a cached Chromium via the optional
 * `playwright-core` dependency — see `src/parity/playtest/`. Read-only: they never
 * write to the project (PNGs go to the OS temp dir unless `out` says otherwise).
 */

const REQUIREMENTS =
  'Needs Node.js 20 or newer, the optional dependency playwright-core and a Chromium from the Playwright cache (`npx playwright install chromium-headless-shell`) or the RPGMAKER_MCP_CHROMIUM env var.';

const inlineArg = z
  .boolean()
  .optional()
  .describe(
    'Also return the PNG(s) as image content in the response (default false: paths only — read the file to view it).',
  );

export const playtestToolDefinitions: ToolDefinition[] = [
  {
    name: 'render_map',
    description:
      'Screenshot a map as the game actually draws it: boots the project headless, starts a new game on the map, and saves a PNG. Validators prove structure, not looks — use this to catch wrong wall/autotile kinds, void (unbased transparent tiles), odd sprites or missing images. Default renders the WHOLE map (canvas resized to width×height×48px, player hidden, autorun/parallel events frozen, map-name banner off); pass x+y for a normal 816×624 game-screen view centred on that tile. Returns the PNG path plus `problems` — console errors, page errors and HTTP 404s (missing assets — a missing image is drawn blank instead of stopping the engine on its load-error retry screen). Read-only. ' +
      REQUIREMENTS,
    inputSchema: {
      mapId: z.number().int().positive().describe('Map to render.'),
      x: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'With y: render a normal screen view centred on this tile instead of the whole map.',
        ),
      y: z.number().int().min(0).optional(),
      showEvents: z
        .boolean()
        .optional()
        .describe('Draw event sprites (default true). false = bare tiles only.'),
      showPlayer: z
        .boolean()
        .optional()
        .describe('Draw the player (default: hidden for a whole-map render, shown for a view).'),
      switches: z
        .array(z.number().int().positive())
        .optional()
        .describe('Switch ids to turn ON first, to see event pages of a later story state.'),
      runEvents: z
        .boolean()
        .optional()
        .describe('Let autorun/parallel events run before the shot (default false: resting map).'),
      out: z
        .string()
        .optional()
        .describe(
          'Output .png path, or a directory. Default: <os tmpdir>/rpgmaker-mv-mcp/renders.',
        ),
      inline: inlineArg,
    },
    handler: (ctx, args) =>
      renderMap(ctx.projectPath, {
        mapId: args.mapId,
        x: args.x,
        y: args.y,
        showEvents: args.showEvents,
        showPlayer: args.showPlayer,
        switches: args.switches,
        runEvents: args.runEvents,
        out: args.out,
      }),
    images: (result, args) => (args.inline ? [(result as RenderMapResult).path] : []),
  },
  {
    name: 'run_playtest',
    description:
      'Play the game headless from a script of steps and report what happened — the runtime check validators cannot do (does the door transfer, does the NPC say the right thing, does the choice branch, is there an invisible wall). One browser session runs the whole script; each step reports its outcome and the run stops at the first failing step. Steps: ' +
      '`load` {mapId,x,y,direction?,party?,level?,gold?,switches?,variables?,selfSwitches?,items?,equip?,encounters?} starts a fresh game there (random encounters off unless encounters:true); ' +
      '`startEvent` {eventId} starts a map event as if triggered and lets it run until it shows text or goes idle (waiting out any transfer — reported as `transferredTo`); ' +
      '`advanceText` {maxMs?} presses OK until the event is idle, STOPPING at an open choice list/battle — returns the map message `lines` shown and any open choices (text shown during a battle comes back separately as `battleLines`); ' +
      '`choose` {index} picks a 0-based choice; ' +
      "`walk` {direction, steps?} walks tile by tile, reporting where it ended (`to`); if a tile refused entry, `stoppedAt` (the player's tile) and `blockedTile` (the refused one); when a step fires a touch event (a door) it stops, waits out the transfer and reports `transferredTo` {mapId,x,y}, plus `eventRunning`/`messageOpen` if the event is still going; " +
      '`press` {button, times?}; `wait` {ms}; ' +
      "`autoBattle` {troopId?, canEscape?, canLose?, maxMs? (default 60000)} fights (a started or new battle) on auto AI until it ends, returning the battle's message `lines` (troop events, victory text). Battles are fast-forwarded (20 engine frames per drawn frame: same logic, same odds, a 10-turn boss fight in seconds) unless the run sets realtime: true; " +
      '`screenshot` {name?} saves a PNG; ' +
      '`eval` {script} evaluates a JS expression in the game page and returns its value (e.g. "$gameSwitches.value(3)"). ' +
      `Reported text reads as the message window shows it: \\V[n]/\\N[n]/\\P[n]/\\G expanded, control codes (\\C[n], \\I[n], \\., \\| …) removed. Every step result carries ok; the response ends with finalState (scene, map, position, gold, party) and problems (console/page errors, HTTP 404s). Max ${MAX_STEPS} steps. Read-only: never writes the project. ` +
      'A run can take MINUTES (booting ~5-10 s, long cutscenes, realtime battles): clients should raise their request timeout, or send a progressToken with resetTimeoutOnProgress — the tool then sends a progress notification per step and every 5 s during long ones. Split long scripts into several runs if your client can do neither. ' +
      REQUIREMENTS,
    inputSchema: {
      steps: playtestSteps.describe('The script, run in order.'),
      out: z
        .string()
        .optional()
        .describe('Directory for screenshot PNGs. Default: <os tmpdir>/rpgmaker-mv-mcp/renders.'),
      inline: inlineArg,
      realtime: z
        .boolean()
        .optional()
        .describe(
          'Play battles at real-time speed (default false: battles are fast-forwarded). Real time takes ~10-20x longer — raise autoBattle maxMs to match.',
        ),
    },
    handler: (ctx, args) =>
      runPlaytest(ctx.projectPath, args.steps, {
        out: args.out,
        onProgress: ctx.reportProgress,
        realtime: args.realtime,
      }),
    images: (result, args) => (args.inline ? (result as PlaytestResult).screenshots : []),
  },
];

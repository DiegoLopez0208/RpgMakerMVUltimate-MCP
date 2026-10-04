import { getMap } from '../tools/mapTools.js';
import { DEFAULT_VIEWPORT, openSession } from './session.js';
import { resolvePngPath, stamp } from './output.js';

/** RPG Maker MV tile size in pixels. */
export const TILE_PX = 48;

/**
 * Upper bound on a whole-map render's canvas edge. Past this, WebGL texture
 * limits and screenshot memory get dicey in a software-rendered headless shell;
 * larger maps can still be inspected as normal views centred on a tile.
 */
export const MAX_RENDER_EDGE_PX = 4800;

export interface RenderMapOptions {
  mapId: number;
  /** Centre a normal game-screen view on this tile. Omit both for the whole map. */
  x?: number;
  y?: number;
  showEvents?: boolean;
  /** Default: hidden for a whole-map render, visible for a view. */
  showPlayer?: boolean;
  /** Let autorun/parallel events run before the shot (default false: resting map). */
  runEvents?: boolean;
  /** Switch ids to turn ON before loading, to see the map in a later story state. */
  switches?: number[];
  /** A .png path, or a directory to write into. Default: the OS temp dir. */
  out?: string;
  /** Extra settle time after the map is ready, for animations/pictures. */
  settleMs?: number;
}

export interface RenderPlan {
  mode: 'whole_map' | 'view';
  /** Player/transfer tile. For a whole-map render, the view is pinned to (0,0). */
  x: number;
  y: number;
  viewport: { width: number; height: number };
  showPlayer: boolean;
}

/**
 * Pure: decide how to render a `width`×`height` map for the given options, or
 * throw a caller-facing message for an invalid request.
 */
export function planRender(
  map: { width: number; height: number },
  opts: Pick<RenderMapOptions, 'x' | 'y' | 'showPlayer'>,
): RenderPlan {
  const hasX = opts.x !== undefined;
  const hasY = opts.y !== undefined;
  if (hasX !== hasY) {
    throw new Error(
      'Pass both x and y to centre a view on a tile, or neither to render the whole map.',
    );
  }
  if (hasX) {
    const x = opts.x as number;
    const y = opts.y as number;
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
      throw new Error(`Tile (${x}, ${y}) is outside the ${map.width}×${map.height} map.`);
    }
    return {
      mode: 'view',
      x,
      y,
      viewport: { ...DEFAULT_VIEWPORT },
      showPlayer: opts.showPlayer ?? true,
    };
  }
  const width = map.width * TILE_PX;
  const height = map.height * TILE_PX;
  if (width > MAX_RENDER_EDGE_PX || height > MAX_RENDER_EDGE_PX) {
    throw new Error(
      `The ${map.width}×${map.height} map is ${width}×${height}px, over the ${MAX_RENDER_EDGE_PX}px whole-map render limit. ` +
        'Pass x and y to render a normal screen view centred on a tile instead.',
    );
  }
  return {
    mode: 'whole_map',
    x: 0,
    y: 0,
    viewport: { width, height },
    showPlayer: opts.showPlayer ?? false,
  };
}

export interface RenderMapResult {
  path: string;
  mapId: number;
  mode: 'whole_map' | 'view';
  tiles: { width: number; height: number };
  pixels: { width: number; height: number };
  /** Console errors, page errors and HTTP >= 400 responses (e.g. a missing image). */
  problems: string[];
}

/** Boot the game headless, transfer to the map, and screenshot it to a PNG. */
export async function renderMap(
  projectPath: string,
  opts: RenderMapOptions,
): Promise<RenderMapResult> {
  const map = (await getMap(projectPath, opts.mapId)) as { width: number; height: number };
  const plan = planRender(map, opts);
  const suffix = plan.mode === 'view' ? `_${plan.x}_${plan.y}` : '';
  const path = await resolvePngPath(opts.out, `map${opts.mapId}${suffix}_${stamp()}.png`);

  const session = await openSession(projectPath, { viewport: plan.viewport });
  try {
    if (plan.mode === 'whole_map') {
      await session.call('resizeToMap', plan.viewport.width, plan.viewport.height);
    }
    if (!opts.runEvents) await session.call('suppressEvents');
    await session.call('load', {
      mapId: opts.mapId,
      x: plan.x,
      y: plan.y,
      direction: 2,
      switches: opts.switches ?? [],
      hidePlayer: !plan.showPlayer,
      hideMapName: true,
    });
    await session.waitFor(`map ${opts.mapId} to load`, 'mapReady');
    if (plan.mode === 'whole_map') await session.call('frameWholeMap');
    if (opts.showEvents === false) await session.call('hideEvents');
    // Character sheets load after the spriteset is built; give them a beat, then
    // wait for the image cache to drain.
    await session.page.waitForTimeout(opts.settleMs ?? 400);
    await session.waitFor('map images to load', 'imagesReady');
    await session.page.waitForTimeout(100);
    await session.page.screenshot({ path });
    return {
      path,
      mapId: opts.mapId,
      mode: plan.mode,
      tiles: { width: map.width, height: map.height },
      pixels: { ...plan.viewport },
      problems: [...session.problems],
    };
  } finally {
    await session.close();
  }
}

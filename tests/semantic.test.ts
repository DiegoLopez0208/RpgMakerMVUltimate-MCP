import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { classifyTile, profileTileFor, emptyProfile, type SemanticTemplate, type SemanticToken } from '../src/knowledge/semantic.js';
import { materializeTemplate } from '../src/utils/materialize.js';
import { buildMissionGraph, generateSemanticLayout } from '../src/utils/graphGenerator.js';
import { mineProject, loadMinedTemplates, getMinedProfile } from '../src/intel/templateMiner.js';
import { computeMapMetrics } from '../src/intel/mapMetrics.js';
import { TILE_ID_A1, TILE_ID_A2, TILE_ID_A4, TILE_ID_A5, autotileKind } from '../src/utils/engine.js';

const GROUND = TILE_ID_A2;            // A2 kind 0, shape 0
const WALL = TILE_ID_A4 + 8 * 48;     // A4 kind 8 = a wall side
const WATER = TILE_ID_A1;             // A1 kind 0 = open water
const PROP = 48;                      // a B-sheet decoration

/** Passage flags shaped like a real tileset: A4 wall sides block, the rest do not. */
function wallFlags(): number[] {
  const flags: number[] = new Array(8192).fill(0);
  for (let id = TILE_ID_A4; id < 8192; id++) flags[id] = 15;
  return flags;
}

const dirs: string[] = [];
async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-semantic-'));
  dirs.push(dir);
  await mkdir(join(dir, 'data'), { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('classifyTile', () => {
  it('names the sheets it can recognise on sight', () => {
    expect(classifyTile(GROUND, 0)).toBe('ground');
    expect(classifyTile(WATER, 0)).toBe('water');
    expect(classifyTile(WALL, 0)).toBe('wall');
    expect(classifyTile(TILE_ID_A4, 0)).toBe('wall_top'); // A4 kind 0 is a wall top
    expect(classifyTile(0, 0)).toBe('void');
  });

  it('treats anything under an upper-layer tile as a prop', () => {
    expect(classifyTile(GROUND, PROP)).toBe('prop');
  });

  it('believes the passage flags over the sheet for static tiles', () => {
    const flags: number[] = [];
    flags[TILE_ID_A5 + 3] = 15;
    expect(classifyTile(TILE_ID_A5 + 3, 0, flags)).toBe('wall');
    expect(classifyTile(TILE_ID_A5 + 3, 0, null)).toBe('ground_alt');
  });
});

describe('profileTileFor', () => {
  it('falls back the way a person would', () => {
    const profile = emptyProfile(1);
    profile.tiles.ground = GROUND;
    profile.tiles.water = WATER;
    expect(profileTileFor(profile, 'ground_alt')).toBe(GROUND); // alt ground is still ground
    expect(profileTileFor(profile, 'waterfall')).toBe(WATER);
    expect(profileTileFor(profile, 'door')).toBe(GROUND);
  });

  it('paints nothing when even the fallback is missing', () => {
    expect(profileTileFor(emptyProfile(1), 'wall')).toBe(0);
  });
});

describe('materializeTemplate', () => {
  function template(grid: SemanticToken[], width: number, height: number, extra: Partial<SemanticTemplate> = {}): SemanticTemplate {
    return { id: 't', name: 'T', width, height, grid, props: [], markers: [], ...extra };
  }

  it('paints each token with the tile its profile names', () => {
    const profile = emptyProfile(3);
    profile.tiles.ground = GROUND;
    profile.tiles.wall = WALL;

    const grid: SemanticToken[] = ['wall', 'ground', 'ground', 'wall'];
    const out = materializeTemplate(template(grid, 2, 2), profile);

    expect(out.tilesetId).toBe(3);
    expect(out.data).toHaveLength(2 * 2 * 6);
    // Autotile kinds survive; only the shape is recomputed.
    expect(autotileKind(out.data[0])).toBe(autotileKind(WALL));
    expect(autotileKind(out.data[1])).toBe(autotileKind(GROUND));
  });

  it('recomputes autotile shapes instead of leaving everything at shape 0', () => {
    const profile = emptyProfile(1);
    profile.tiles.ground = GROUND;
    profile.tiles.wall = WALL;
    // A single ground cell surrounded by wall must not keep shape 0, or it
    // renders as open field with no edges.
    const grid: SemanticToken[] = [
      'wall', 'wall', 'wall',
      'wall', 'ground', 'wall',
      'wall', 'wall', 'wall',
    ];
    const out = materializeTemplate(template(grid, 3, 3), profile);
    expect(out.data[4]).not.toBe(GROUND);
    expect(autotileKind(out.data[4])).toBe(autotileKind(GROUND));
  });

  it('puts ground under doors and interaction points', () => {
    const profile = emptyProfile(1);
    profile.tiles.ground = GROUND;
    profile.tiles.wall = WALL;
    const out = materializeTemplate(template(['door', 'poi'], 2, 1), profile);
    expect(out.data[0]).toBeGreaterThan(0);
    expect(out.data[1]).toBeGreaterThan(0);
  });

  it('drops props when the target tileset is not the one they came from', () => {
    const profile = emptyProfile(9);
    profile.tiles.ground = GROUND;
    const withProp = template(['ground', 'ground'], 2, 1, {
      sourceTilesetId: 1,
      props: [{ x: 0, y: 0, width: 1, height: 1, cells: [[0, 0, 2, PROP]], signature: 'p' }],
    });

    const foreign = materializeTemplate(withProp, profile);
    expect(foreign.droppedProps).toBe(1);
    expect(foreign.data[2 * 1 * 2]).toBe(0); // layer 2, cell 0,0

    const native = materializeTemplate(withProp, emptyProfile(1));
    expect(native.droppedProps).toBe(0);
  });
});

describe('buildMissionGraph', () => {
  const rand = () => 0.5;

  it('puts the key before the door it opens', () => {
    const graph = buildMissionGraph({ rooms: 6, locked: true, sideRooms: 0, rand });
    const locked = graph.edges.find((e) => e.lockedBy !== undefined);
    expect(locked).toBeDefined();
    const keyNode = graph.nodes.find((n) => n.id === locked!.lockedBy);
    expect(keyNode?.role).toBe('key');
    // Solvable by construction: the key is reachable before the lock.
    expect(keyNode!.depth).toBeLessThan(graph.nodes[locked!.to].depth);
  });

  it('always has an entrance, a boss and an exit', () => {
    const roles = buildMissionGraph({ rooms: 5, locked: false, sideRooms: 0, rand }).nodes.map((n) => n.role);
    expect(roles).toContain('entrance');
    expect(roles).toContain('boss');
    expect(roles).toContain('exit');
  });

  it('does not lock a mission too short to hide a key in', () => {
    const graph = buildMissionGraph({ rooms: 3, locked: true, sideRooms: 0, rand });
    expect(graph.edges.every((e) => e.lockedBy === undefined)).toBe(true);
  });
});

describe('generateSemanticLayout', () => {
  it('is deterministic for a seed', () => {
    const a = generateSemanticLayout({ width: 30, height: 22, seed: 7 });
    const b = generateSemanticLayout({ width: 30, height: 22, seed: 7 });
    expect(a.grid).toEqual(b.grid);
    expect(generateSemanticLayout({ width: 30, height: 22, seed: 8 }).grid).not.toEqual(a.grid);
  });

  it('carves rooms out of solid rock and marks the mission', () => {
    const layout = generateSemanticLayout({ width: 34, height: 24, seed: 3, rooms: 5 });
    expect(layout.grid.filter((t) => t === 'ground').length).toBeGreaterThan(20);
    expect(layout.grid.filter((t) => t === 'wall').length).toBeGreaterThan(20);
    const roles = layout.markers.map((m) => m.role);
    expect(roles).toContain('entrance');
    expect(roles).toContain('boss');
  });
});

describe('the whole pipeline', () => {
  it('produces a map with no stranded tiles and something to walk around', () => {
    const layout = generateSemanticLayout({ width: 40, height: 28, seed: 11, rooms: 5, sideRooms: 2, loop: true });
    const profile = emptyProfile(1);
    profile.tiles.ground = GROUND;
    profile.tiles.wall = WALL;

    const built = materializeTemplate(layout, profile);
    const entrance = layout.markers.find((m) => m.role === 'entrance');
    const metrics = computeMapMetrics(built, wallFlags(), [], {
      entry: entrance ? { x: entrance.x, y: entrance.y } : null,
      expected: 'dungeon',
    });

    expect(metrics.passability).toBe('flags');
    // Every carved corridor connects, so nothing is walled off from the entrance.
    expect(metrics.reachability.strandedTiles).toBe(0);
    // The extra corridor gives the player a route choice.
    expect(metrics.shape.cycles).toBeGreaterThanOrEqual(1);
  });
});

describe('mineProject', () => {
  /** A small hand-built project: one 12x10 map with a room, water and a prop. */
  async function seedProject(dir: string) {
    const width = 12, height = 10;
    const data = new Array<number>(width * height * 6).fill(0);
    const put = (x: number, y: number, z: number, id: number) => { data[(z * height + y) * width + x] = id; };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        put(x, y, 0, edge ? WALL : GROUND);
      }
    }
    for (let x = 4; x <= 6; x++) put(x, 4, 0, WATER);
    // A 2x1 prop on the upper layer.
    put(2, 2, 2, PROP);
    put(3, 2, 2, PROP + 1);

    await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify([null, { id: 1, name: 'Test Cavern', parentId: 0 }]), 'utf-8');
    await writeFile(join(dir, 'data', 'Tilesets.json'), JSON.stringify([null, { id: 1, name: 'Dungeon', flags: wallFlags() }]), 'utf-8');
    await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify({
      width, height, tilesetId: 1, data,
      events: [null, {
        id: 1, name: 'Exit Door', x: 6, y: 8,
        pages: [{ list: [{ code: 201, parameters: [0, 2, 5, 5, 0, 0] }, { code: 0 }] }],
      }],
    }), 'utf-8');
    return { width, height };
  }

  it('learns which tile plays each role and caches the result', async () => {
    const dir = await tempProject();
    await seedProject(dir);

    const result = await mineProject(dir, { minDistinctTiles: 4 });
    expect(result.mapsScanned).toBe(1);
    expect(result.mapsKept).toBe(1);

    const profile = result.profiles['1'];
    expect(profile.tilesetName).toBe('Dungeon');
    expect(profile.tiles.ground).toBe(GROUND);
    expect(profile.tiles.wall).toBe(WALL);
    expect(profile.tiles.water).toBe(WATER);
    // Ground covers most of the map, so it is the most confident mapping.
    expect(profile.confidence.ground).toBeGreaterThan(profile.confidence.water ?? 0);

    const cached = JSON.parse(await readFile(join(dir, '.mcp-cache', 'project-templates.json'), 'utf-8'));
    expect(cached.version).toBe(1);
    expect(new Date(cached.minedAt).toString()).not.toBe('Invalid Date');
  });

  it('lifts multi-tile props out whole and marks doors from their events', async () => {
    const dir = await tempProject();
    await seedProject(dir);
    const result = await mineProject(dir, { noWrite: true, minDistinctTiles: 4 });

    const template = result.templates[0];
    expect(template.sourceMapId).toBe(1);
    expect(template.name).toBe('Test Cavern');

    // The two adjacent decoration tiles are one 2x1 object, not two props.
    expect(template.props).toHaveLength(1);
    expect(template.props[0]).toMatchObject({ x: 2, y: 2, width: 2, height: 1 });

    // The transfer event turns its cell into a door in the layout.
    expect(template.grid[8 * template.width + 6]).toBe('door');
    expect(template.markers.find((m) => m.role === 'door')?.note).toBe('Exit Door');
  });

  it('counts which tokens sit next to which', async () => {
    const dir = await tempProject();
    await seedProject(dir);
    const result = await mineProject(dir, { noWrite: true, minDistinctTiles: 4 });
    expect(result.adjacency.horizontal['ground>ground']).toBeGreaterThan(0);
    expect(result.adjacency.horizontal['ground>water']).toBeGreaterThan(0);
  });

  it('skips scratch maps instead of learning from them', async () => {
    const dir = await tempProject();
    await seedProject(dir);
    // A second map with a single tile repeated: not content.
    const blank = new Array<number>(12 * 10 * 6).fill(0);
    for (let i = 0; i < 12 * 10; i++) blank[i] = GROUND;
    await writeFile(join(dir, 'data', 'MapInfos.json'), JSON.stringify([
      null, { id: 1, name: 'Test Cavern' }, { id: 2, name: 'scratch' },
    ]), 'utf-8');
    await writeFile(join(dir, 'data', 'Map002.json'), JSON.stringify({ width: 12, height: 10, tilesetId: 1, data: blank, events: [] }), 'utf-8');

    const result = await mineProject(dir, { noWrite: true, minDistinctTiles: 4 });
    expect(result.mapsScanned).toBe(2);
    expect(result.mapsKept).toBe(1);
    expect(result.skipped[0].mapId).toBe(2);
    expect(result.skipped[0].reason).toMatch(/scratch/);
  });

  it('reads back a cached mine and its profiles', async () => {
    const dir = await tempProject();
    await seedProject(dir);
    await mineProject(dir, { minDistinctTiles: 4 });

    expect((await loadMinedTemplates(dir))?.mapsKept).toBe(1);
    expect((await getMinedProfile(dir, 1))?.tiles.ground).toBe(GROUND);
    expect(await getMinedProfile(dir, 99)).toBeNull();
  });

  it('returns null rather than throwing when nothing was mined yet', async () => {
    const dir = await tempProject();
    expect(await loadMinedTemplates(dir)).toBeNull();
  });
});

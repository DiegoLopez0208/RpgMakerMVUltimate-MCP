import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../src/parity/utils/commit.js';
import {
  blankEventPage,
  setEventPage,
  createNpc,
  eventPageToolDefinitions,
} from '../src/parity/tools/eventPageTools.js';
import { blankMapData } from '../src/parity/tools/mapTools.js';
import { MapData, MapEvent } from '../src/parity/utils/types.js';

function eventWithGraphicPage(id: number): MapEvent {
  const page = blankEventPage();
  page.image.characterName = 'People1';
  page.image.characterIndex = 2;
  return { id, name: `EV${id}`, note: '', x: 3, y: 4, pages: [page] };
}

/** Scaffold a temp project. `characters` = sprite basenames to seed img/characters. */
async function scaffoldProject(characters: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmz-page-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.2');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  const map: MapData = blankMapData(17, 13, 1);
  map.events = [null, eventWithGraphicPage(1)];
  await writeFile(join(dir, 'data', 'Map001.json'), JSON.stringify(map));
  if (characters.length > 0) {
    await mkdir(join(dir, 'img', 'characters'), { recursive: true });
    for (const name of characters)
      await writeFile(join(dir, 'img', 'characters', `${name}.png`), '');
  }
  return dir;
}

const get = (name: string) => eventPageToolDefinitions.find((t) => t.name === name)!;

describe('blankEventPage', () => {
  it('mirrors the editor default (no graphic, empty terminated list, action-button)', () => {
    const page = blankEventPage();
    expect(page.image).toEqual({
      characterName: '',
      characterIndex: 0,
      direction: 2,
      pattern: 0,
      tileId: 0,
    });
    expect(page.list).toEqual([{ code: 0, indent: 0, parameters: [] }]);
    expect(page.trigger).toBe(0);
    expect(page.priorityType).toBe(0);
    expect(page.walkAnime).toBe(true);
  });
});

describe('set_event_page (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject(['People1', 'Actor1']);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges graphic fields and overwrites behavior, leaving the list untouched', async () => {
    const result = (await get('set_event_page').handler(
      { projectPath: dir },
      {
        mapId: 1,
        eventId: 1,
        pageIndex: 0,
        direction: 'up',
        trigger: 'parallel',
        priority: 'above',
        through: true,
        moveType: 'custom',
      },
    )) as { event: MapEvent; warnings?: unknown[] };

    const page = result.event.pages[0];
    // direction merged, sprite preserved
    expect(page.image.characterName).toBe('People1');
    expect(page.image.characterIndex).toBe(2);
    expect(page.image.direction).toBe(8);
    expect(page.trigger).toBe(4);
    expect(page.priorityType).toBe(2);
    expect(page.through).toBe(true);
    expect(page.moveType).toBe(3);
    expect(page.list.map((c) => c.code)).toEqual([0]);
    expect(result.warnings).toBeUndefined();
  });

  it('persists compactly and swaps the sprite', async () => {
    await get('set_event_page').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, characterName: 'Actor1', characterIndex: 5 },
    );
    const raw = await readFile(join(dir, 'data', 'Map001.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    const map = JSON.parse(raw) as MapData;
    expect(map.events[1]!.pages[0].image.characterName).toBe('Actor1');
    expect(map.events[1]!.pages[0].image.characterIndex).toBe(5);
  });

  it('warns (never throws) on an unknown characterName', async () => {
    const result = (await get('set_event_page').handler(
      { projectPath: dir },
      { mapId: 1, eventId: 1, pageIndex: 0, characterName: 'Ghost' },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects an unknown event or page', async () => {
    await expect(setEventPage(dir, 1, 99, 0, { through: true })).rejects.toThrow(/Event 99/);
    await expect(setEventPage(dir, 1, 1, 5, { through: true })).rejects.toThrow(/Page 5/);
  });

  it('dry-run previews without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await setEventPage(dir, 1, 1, 0, { through: true });
    });
    expect(context.commits.some((c) => c.path.endsWith('Map001.json'))).toBe(true);
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[1]!.pages[0].through).toBe(false);
  });

  it('is marked as mutating', () => {
    expect(get('set_event_page').mutates).toBe(true);
  });
});

describe('create_npc (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scaffoldProject(['People1']);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a placed talking NPC from text, with sane graphic/trigger defaults', async () => {
    const result = (await get('create_npc').handler(
      { projectPath: dir },
      {
        mapId: 1,
        x: 7,
        y: 8,
        name: 'Villager',
        characterName: 'People1',
        text: ['Hello there!', 'Welcome to town.'],

      },
    )) as { event: { id: number; name: string; x: number; y: number }; warnings?: unknown[] };

    expect(result.warnings).toBeUndefined();
    // The handler returns a compact summary, not the full event.
    const ev = result.event;
    expect(ev.id).toBe(2); // next id after the seeded event
    expect(ev.x).toBe(7);
    expect(ev.y).toBe(8);

    // Page details are read back off the persisted map file.
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[2]!.name).toBe('Villager');
    const page = map.events[2]!.pages[0];
    expect(page.image.characterName).toBe('People1');
    expect(page.image.pattern).toBe(1); // idle frame when a sprite is set
    expect(page.trigger).toBe(0); // action_button
    expect(page.priorityType).toBe(1); // same as characters (solid)
    // Show Text sequence, terminated
    expect(page.list.map((c) => c.code)).toEqual([101, 401, 401, 0]);
    expect(page.list[0].parameters).toHaveLength(4); // MV has no native speaker name
  });

  it('word-wraps a paragraph into face-width 4-line boxes with `wrap: true`', async () => {
    const paragraph =
      'The old mill has stood by the river for as long as anyone remembers, but lately the wheel turns at night with nobody inside, and the miller swears he hears singing under the floorboards. Would you look into it?';
    const result = (await get('create_npc').handler(
      { projectPath: dir },
      {
        mapId: 1,
        x: 3,
        y: 3,
        name: 'Miller',
        characterName: 'People1',
        faceName: 'People1',
        text: [paragraph],
        wrap: true,
      },
    )) as { event: { id: number }; warnings?: unknown[] };

    expect(result.warnings).toBeUndefined();
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    const list = map.events[result.event.id]!.pages[0].list;
    expect(list.filter((c) => c.code === 101).length).toBeGreaterThan(1);
    const lines = list.filter((c) => c.code === 401).map((c) => c.parameters[0] as string);
    expect(lines.join(' ')).toBe(paragraph);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(38);
  });

  it('prefers an explicit commands list over text and terminates it', async () => {
    const event = await createNpc(dir, 1, 1, 1, 'Signpost', {
      commands: [{ code: 108, indent: 0, parameters: ['A note'] }],
      text: ['ignored'],
    });
    expect(event.pages[0].list.map((c) => c.code)).toEqual([108, 0]);
    // No graphic → pattern stays 0
    expect(event.pages[0].image.pattern).toBe(0);
  });

  it('warns (never throws) on an unknown characterName', async () => {
    const result = (await get('create_npc').handler(
      { projectPath: dir },
      { mapId: 1, x: 1, y: 1, name: 'Ghost', characterName: 'NotReal', text: ['boo'] },
    )) as { event: { id: number }; warnings?: unknown[] };
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
    // Still created despite the warning.
    const map = JSON.parse(await readFile(join(dir, 'data', 'Map001.json'), 'utf-8')) as MapData;
    expect(map.events[result.event.id]!.pages[0].image.characterName).toBe('NotReal');
  });

  it('warns (never throws) when no graphic is set — an invisible NPC (F1)', async () => {
    const result = (await get('create_npc').handler(
      { projectPath: dir },
      { mapId: 1, x: 1, y: 1, name: 'Signpost', text: ['Read me.'] },
    )) as { event: MapEvent; warnings?: { path: string; message: string }[] };
    expect(result.warnings?.some((w) => /invisible/.test(w.message))).toBe(true);
    // Still created despite the warning.
    expect(result.event.name).toBe('Signpost');
  });

  it('does NOT emit the no-graphic warning when a characterName is set', async () => {
    const result = (await get('create_npc').handler(
      { projectPath: dir },
      { mapId: 1, x: 1, y: 1, name: 'Villager', characterName: 'People1', text: ['Hi'] },
    )) as { event: MapEvent; warnings?: unknown[] };
    expect(result.warnings).toBeUndefined();
  });

  it('is marked as mutating', () => {
    expect(get('create_npc').mutates).toBe(true);
  });
});

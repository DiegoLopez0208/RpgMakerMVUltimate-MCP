import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createActor, getActors, searchActors, defaultActor } from '../../src/parity/tools/actorTools.js';
import { Actor } from '../../src/parity/utils/types.js';

/** Scaffold a minimal RPG Maker MZ project with a seeded Actors.json. */
async function scaffoldProject(actors: (Actor | null)[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-actors-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'Actors.json'), JSON.stringify(actors));
  return dir;
}

const reid: Actor = {
  id: 1,
  name: 'Reid',
  nickname: 'Hero',
  profile: '',
  classId: 1,
  initialLevel: 1,
  maxLevel: 99,
  characterName: '',
  characterIndex: 0,
  faceName: '',
  faceIndex: 0,
  battlerName: '',
  traits: [],
  equips: [0, 0, 0, 0, 0],
  note: '',
} as Actor;

describe('actor tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // RPG Maker's Actors.json is a 1-indexed array whose slot 0 is null.
    dir = await scaffoldProject([null, reid]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads seeded actors', async () => {
    const actors = await getActors(dir);
    expect(actors[1]?.name).toBe('Reid');
  });

  it('createActor assigns the next id and persists compactly', async () => {
    const { id: _id, ...actorData } = reid;
    const created = await createActor(dir, { ...actorData, name: 'Gale', nickname: '' });
    expect(created.id).toBe(2);

    // Re-read from disk to confirm the write landed.
    const actors = await getActors(dir);
    expect(actors.find((a) => a?.id === 2)?.name).toBe('Gale');

    const raw = await readFile(join(dir, 'data', 'Actors.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createActor with only a name fills every field from the default template', async () => {
    const created = await createActor(dir, { name: 'Solo' });
    expect(created.id).toBe(2);

    // The record must be complete key-for-key against the reference default actor
    // (a missing equips/traits array crashes the engine on load).
    const { id: _id, name: _name, ...rest } = created;
    const { name: _dn, ...defaultRest } = defaultActor();
    expect(rest).toEqual(defaultRest);
    expect(created.equips).toEqual([0, 0, 0, 0, 0]);
    expect(created.traits).toEqual([]);
  });

  it('searchActors matches by name and nickname, case-insensitively', async () => {
    expect((await searchActors(dir, 'reid')).map((a) => a.id)).toEqual([1]);
    expect((await searchActors(dir, 'HERO')).map((a) => a.id)).toEqual([1]);
    expect(await searchActors(dir, 'nobody')).toEqual([]);
  });
});

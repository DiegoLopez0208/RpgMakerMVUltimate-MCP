import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { encodePng } from '../src/parity/tiles/png.js';
const exec = promisify(execFile);
const roots: string[] = [];
const scripts = resolve('skill/mv-tileset-catalog/scripts');
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'mv-catalog-cli-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true}); });
describe('MV catalog bootstrap scripts', () => {
  it('slices an arbitrarily named MV sheet with an explicit slot role', async () => {
    const root = await fixture();
    const input = join(root, 'DungeonDecor.png');
    await writeFile(input, encodePng(384, 768, Buffer.alloc(384*768*4, 255)));
    await exec(process.execPath, [join(scripts, 'slice-tileset.mjs'), input, root, 'B']);
    const samples = JSON.parse(await readFile(join(root, 'DungeonDecor.samples.json'), 'utf8'));
    expect(samples.role).toBe('B');
    expect(samples.samples).toHaveLength(128);
    expect(samples.samples[0].index).toBe(0);
  });
  it('previews metadata without writes and preserves manually verified names on merge', async () => {
    const root = await fixture();
    const target = join(root, 'data/tilecatalog/Decor.json');
    await mkdir(join(root, 'data/tilecatalog'), {recursive: true});
    const original = JSON.stringify({sheet:'Decor',version:1,entries:{0:{name:'Verified',manual:true},1:{name:'Old',manual:false}}});
    await writeFile(target, original);
    const input = join(root,'naming.json');
    await writeFile(input, JSON.stringify({sheet:'Decor',role:'B',entries:{0:{name:'Guess'},1:{name:'New'}}}));
    await exec(process.execPath, [join(scripts,'write-catalog.mjs'),input,root,'--dry-run']);
    expect(await readFile(target,'utf8')).toBe(original);
    await exec(process.execPath, [join(scripts,'write-catalog.mjs'),input,root]);
    const output=JSON.parse(await readFile(target,'utf8'));
    expect(output.entries[0].name).toBe('Verified');
    expect(output.entries[1].name).toBe('New');
    expect(output.entries[1].passability).toBeNull();
    expect(output.version).toBe(2);
  });
  it('refuses path-like sheet names and invalid local indices', async () => {
    const root=await fixture(); const input=join(root,'naming.json');
    for (const data of [{sheet:'../outside',entries:{0:{name:'A'}}},{sheet:'A',entries:{99999999:{name:'A'}}}]) {
      await writeFile(input,JSON.stringify(data));
      await expect(exec(process.execPath,[join(scripts,'write-catalog.mjs'),input,root])).rejects.toThrow();
    }
  });
});

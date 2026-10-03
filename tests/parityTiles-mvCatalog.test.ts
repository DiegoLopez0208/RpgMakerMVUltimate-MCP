import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MV_TILE_CATALOGS } from '../src/parity/tiles/catalog/mv.js';
import { catalogForTileset, hasCatalog, parseTileSidecar } from '../src/parity/tiles/catalog/index.js';
import { loadCatalogOverlay } from '../src/parity/tools/catalogTools.js';

const projects: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'mv-parity-catalog-'));
  projects.push(root);
  await mkdir(join(root, 'img/tilesets'), { recursive: true });
  await mkdir(join(root, 'data/tilecatalog'), { recursive: true });
  return root;
}
afterEach(async () => { for (const root of projects.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('MV catalog provenance', () => {
  it.skipIf(!process.env.MV_RTP_DIR)('recognizes a renamed licensed MV PNG by fingerprint, without a filename or sidecar assumption', async () => {
    const root = await project();
    await copyFile(join(process.env.MV_RTP_DIR!, 'Outside_A2.png'), join(root,'img/tilesets/Renamed.png'));
    const names = ['', 'Renamed'];
    const entries = catalogForTileset(names, undefined, await loadCatalogOverlay(root,names));
    expect(entries[0].name).toBe('Meadow');
    expect(entries[0].source).toBe('builtin');
    expect(entries[0].tileId).toBe(2816);
  });
  it('derives MV names and fingerprints without including any image data', () => {
    expect(MV_TILE_CATALOGS.Outside_A2.names[0]).toBe('Meadow');
    expect(MV_TILE_CATALOGS.Outside_A2.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(MV_TILE_CATALOGS).length).toBeGreaterThan(20);
  });
  it('does not label a custom image using a reused MV or MZ sheet filename', async () => {
    const root = await project();
    await writeFile(join(root, 'img/tilesets/Outside_A2.png'), 'custom pixels');
    const names = ['', 'Outside_A2'];
    const overlay = await loadCatalogOverlay(root, names);
    expect(catalogForTileset(names, undefined, overlay)).toEqual([]);
    expect(hasCatalog(names, overlay)).toBe(false);
  });
  it('uses per-tile manual > sidecar > draft precedence and preserves index holes', async () => {
    const root = await project();
    await writeFile(join(root, 'img/tilesets/DLC.txt'), '\uFEFFFern|シダ\r\n\r\nRope\r\n');
    await writeFile(join(root, 'data/tilecatalog/DLC.json'), JSON.stringify({sheet:'DLC',entries:{
      0:{name:'Manual fern',manual:true},1:{name:'Draft basket',confidence:'low'},2:{name:'Draft rug'},
    }}));
    const names = ['', '', '', '', '', 'DLC'];
    const entries = catalogForTileset(names, undefined, await loadCatalogOverlay(root,names));
    expect(entries.map(e => [e.tileId,e.name,e.source])).toEqual([[0,'Manual fern','project'],[1,'Draft basket','project'],[2,'Rope','sidecar']]);
    expect(entries[1].confidence).toBe('low');
    expect(parseTileSidecar('A\n\nB\n')).toEqual(['A',undefined,'B']);
  });
});

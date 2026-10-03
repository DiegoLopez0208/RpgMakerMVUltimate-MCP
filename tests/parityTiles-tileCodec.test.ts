// Adapted from Redseb/rpgmaker-mz-mcp (MIT); see THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
  TILE_ID,
  isAutotile,
  getAutotileKind,
  getAutotileShape,
  makeAutotileId,
  isSameKindTile,
  isTileA1,
  isTileA2,
  isTileA5,
  autotileType,
  flatSheet,
  decodeTile,
} from '../src/parity/tiles/tileCodec.js';

describe('autotile arithmetic', () => {
  it('round-trips kind + shape through makeAutotileId', () => {
    for (const kind of [0, 1, 5, 80, 127]) {
      for (const shape of [0, 1, 15, 46, 47]) {
        const id = makeAutotileId(kind, shape);
        expect(getAutotileKind(id)).toBe(kind);
        expect(getAutotileShape(id)).toBe(shape);
      }
    }
  });

  it('treats ids below A1 as non-autotile', () => {
    expect(isAutotile(TILE_ID.A1 - 1)).toBe(false);
    expect(isAutotile(TILE_ID.A1)).toBe(true);
  });

  it('isSameKindTile matches autotiles by kind, others by exact id', () => {
    // Two shapes of the same A2 kind connect.
    expect(isSameKindTile(makeAutotileId(3, 0), makeAutotileId(3, 20))).toBe(true);
    // Different kinds do not.
    expect(isSameKindTile(makeAutotileId(3, 0), makeAutotileId(4, 0))).toBe(false);
    // Flat tiles need an exact match.
    expect(isSameKindTile(10, 10)).toBe(true);
    expect(isSameKindTile(10, 11)).toBe(false);
  });
});

describe('sheet classification', () => {
  it('places ids on the right A-sheet at the boundaries', () => {
    expect(isTileA1(TILE_ID.A1)).toBe(true);
    expect(isTileA1(TILE_ID.A2 - 1)).toBe(true);
    expect(isTileA2(TILE_ID.A2)).toBe(true);
    expect(isTileA5(TILE_ID.A5)).toBe(true);
    expect(isTileA5(TILE_ID.A1 - 1)).toBe(true);
  });

  it('classifies flat sheets by range', () => {
    expect(flatSheet(0)).toBe('B');
    expect(flatSheet(TILE_ID.C)).toBe('C');
    expect(flatSheet(TILE_ID.D)).toBe('D');
    expect(flatSheet(TILE_ID.E)).toBe('E');
    expect(flatSheet(TILE_ID.A5)).toBe('A5');
    expect(flatSheet(TILE_ID.A1)).toBe(null); // autotile
  });
});

describe('autotileType', () => {
  it('is null for non-autotiles', () => {
    expect(autotileType(0)).toBe(null);
    expect(autotileType(TILE_ID.A5)).toBe(null);
  });

  it('classifies A2 ground and A1 water as floor', () => {
    expect(autotileType(TILE_ID.A2)).toBe('floor');
    expect(autotileType(TILE_ID.A1)).toBe('floor');
  });

  it('classifies an A1 waterfall kind as waterfall', () => {
    // Fall band is [A1+192, A2) with an odd kind; kind 5 = A1 + 5*48.
    const fall = makeAutotileId(5, 0);
    expect(autotileType(fall)).toBe('waterfall');
  });

  it('classifies A3 roofs and A3/A4 wall sides as wall', () => {
    expect(autotileType(TILE_ID.A3)).toBe('wall'); // A3 kind 48 → roof
    expect(autotileType(makeAutotileId(88, 0))).toBe('wall'); // A4 kind 88 → wall side
  });

  it('classifies A4 wall tops as floor', () => {
    expect(autotileType(TILE_ID.A4)).toBe('floor'); // A4 kind 80 → wall top
  });
});

describe('decodeTile', () => {
  it('marks tile 0 as empty', () => {
    expect(decodeTile(0)).toMatchObject({ empty: true, autotile: false, sheet: 'B' });
  });

  it('decodes an A2 ground autotile', () => {
    const id = makeAutotileId(getAutotileKind(TILE_ID.A2), 3);
    expect(decodeTile(id)).toMatchObject({
      empty: false,
      sheet: 'A2',
      autotile: true,
      shape: 3,
      autotileType: 'floor',
    });
  });

  it('decodes a flat B tile with a sheet index', () => {
    expect(decodeTile(5)).toMatchObject({ sheet: 'B', sheetIndex: 5, autotile: false });
  });

  it('decodes an A5 flat tile', () => {
    expect(decodeTile(TILE_ID.A5 + 10)).toMatchObject({
      sheet: 'A5',
      sheetIndex: 10,
      autotile: false,
    });
  });
});

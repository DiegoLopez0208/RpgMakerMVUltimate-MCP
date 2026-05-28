function setTile(data, width, height, x, y, layer, tileId) {
  if (x >= 0 && x < width && y >= 0 && y < height && layer >= 0 && layer < 6) {
    data[(layer * height + y) * width + x] = tileId;
  }
}

function fillRect(data, width, height, x1, y1, x2, y2, layer, tileId) {
  for (var y = y1; y <= y2; y++) {
    for (var x = x1; x <= x2; x++) {
      setTile(data, width, height, x, y, layer, tileId);
    }
  }
}

function getTile(data, width, height, x, y, layer) {
  if (x < 0 || x >= width || y < 0 || y >= height || layer < 0 || layer >= 6) return 0;
  return data[(layer * height + y) * width + x];
}

function makeAutotileId(kind, shape) {
  return 2048 + kind * 48 + shape;
}

function addShadowBits(data, width, height, x, y, bits) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  var idx = (4 * height + y) * width + x;
  data[idx] = data[idx] | bits;
}

function addRegionId(data, width, height, x, y, regionId) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  data[(5 * height + y) * width + x] = regionId;
}

function selectTile(config, category, index) {
  if (!config || !config.availableTiles) return 0;
  var tiles = config.availableTiles[category];
  if (!tiles || tiles.length === 0) return 0;
  return tiles[index % tiles.length].tileId;
}

var FALLBACK = {
  grass: 2816,
  stone: makeAutotileId(6, 0),
  dirt: makeAutotileId(8, 0),
  water: 2048,
  deepWater: makeAutotileId(1, 0),
  wallDark: makeAutotileId(9, 0) + 4352,
  wallStone: makeAutotileId(8, 0) + 5888,
  roofRed: makeAutotileId(0, 0) + 4352,
  treeB: 1538,
  bushB: 1539,
  flowerB: 1540,
  rockB: 1541,
  pillarB: 1536,
  stumpB: 1537
};

function pickGround(cfg, category, fallback, idx) {
  if (cfg) {
    var t = selectTile(cfg, category, idx || 0);
    if (t) return t;
  }
  return fallback;
}

function pickDeco(cfg, idx) {
  if (cfg) {
    var t = selectTile(cfg, 'decoration', idx || 0);
    if (t) return t;
  }
  return 0;
}

function generateTileLayoutV2(width, height, theme, tilesetConfig) {
  var data = new Array(width * height * 6).fill(0);

  var grass = pickGround(tilesetConfig, 'ground', FALLBACK.grass, 0);
  var stone = pickGround(tilesetConfig, 'ground', FALLBACK.stone, 1);
  var dirt = pickGround(tilesetConfig, 'ground', FALLBACK.dirt, 2);
  var water = pickGround(tilesetConfig, 'water', FALLBACK.water, 0);
  var deepWater = pickGround(tilesetConfig, 'water', FALLBACK.deepWater, 1);
  var wallSide = pickGround(tilesetConfig, 'wallSide', FALLBACK.wallDark, 0);
  var wallTop = pickGround(tilesetConfig, 'wallTop', FALLBACK.roofRed, 0);
  var roof = pickGround(tilesetConfig, 'roof', FALLBACK.roofRed, 0);
  var wallSide2 = pickGround(tilesetConfig, 'wallSide', FALLBACK.wallStone, 1);

  switch (theme) {
  case 'forest':
    generateForest(data, width, height, grass, dirt, water, deepWater, wallSide, roof, tilesetConfig);
    break;
  case 'dungeon':
    generateDungeon(data, width, height, stone, wallSide2, tilesetConfig);
    break;
  case 'town':
    generateTown(data, width, height, grass, dirt, roof, wallSide2, tilesetConfig);
    break;
  case 'castle':
    generateCastle(data, width, height, stone, wallSide2, roof, tilesetConfig);
    break;
  case 'cave':
    generateCave(data, width, height, dirt, water, wallSide2, tilesetConfig);
    break;
  case 'village':
    generateVillage(data, width, height, grass, dirt, roof, wallSide2, tilesetConfig);
    break;
  case 'swamp':
    generateSwamp(data, width, height, grass, dirt, water, deepWater, wallSide, tilesetConfig);
    break;
  case 'desert':
    generateDesert(data, width, height, dirt, water, tilesetConfig);
    break;
  case 'ruins':
    generateRuins(data, width, height, stone, dirt, wallSide2, tilesetConfig);
    break;
  case 'interior':
    generateInterior(data, width, height, stone, wallSide2, tilesetConfig);
    break;
  case 'beach':
    generateBeach(data, width, height, grass, dirt, water, deepWater, tilesetConfig);
    break;
  default:
    fillRect(data, width, height, 0, 0, width - 1, height - 1, 0, grass);
    break;
  }

  return { data: data };
}

function generateForest(data, w, h, grass, dirt, water, deepWater, wallSide, roof, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, grass);

  var cx = Math.floor(w / 2);
  var cy = Math.floor(h / 2);
  var clearR = Math.max(2, Math.floor(Math.min(w, h) / 4));

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var dx = x - cx;
      var dy = y - cy;
      if (dx * dx + dy * dy < clearR * clearR) {
        var grassAlt = pickGround(cfg, 'ground', grass, 2);
        if (grassAlt && ((x + y) % 3 === 0)) setTile(data, w, h, x, y, 0, grassAlt);
      }
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var distEdge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (distEdge === 0) {
        setTile(data, w, h, x, y, 1, roof);
      } else if (distEdge === 1) {
        setTile(data, w, h, x, y, 1, wallSide);
        addShadowBits(data, w, h, x, y + 1, 15);
      }
    }
  }

  var gaps = [
    { x: cx, y: 0 },
    { x: cx, y: h - 1 },
    { x: 0, y: cy },
    { x: w - 1, y: cy }
  ];
  for (var gi = 0; gi < gaps.length; gi++) {
    var g = gaps[gi];
    setTile(data, w, h, g.x, g.y, 1, 0);
    if (g.y > 0 && g.y < h - 1) {
      addShadowBits(data, w, h, g.x, g.y, 0);
    }
  }

  if (h >= 10 && w >= 10) {
    var riverX = Math.floor(w * 0.3);
    for (var y = 0; y < h; y++) {
      var rx = riverX + Math.floor(Math.sin(y * 0.5) * 1.5);
      if (rx >= 0 && rx < w) {
        setTile(data, w, h, rx, y, 0, water);
        if (rx + 1 < w) setTile(data, w, h, rx + 1, y, 0, deepWater);
      }
    }
  }

  var deco1 = pickDeco(cfg, 0) || FALLBACK.flowerB;
  var deco2 = pickDeco(cfg, 1) || FALLBACK.bushB;
  var deco3 = pickDeco(cfg, 2) || FALLBACK.stumpB;
  var seed = 42;
  for (var y = clearR; y < h - clearR; y += 3) {
    for (var x = clearR; x < w - clearR; x += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var r = seed % 3;
      var dx2 = x - cx;
      var dy2 = y - cy;
      if (dx2 * dx2 + dy2 * dy2 > clearR * clearR) {
        if (r === 0) setTile(data, w, h, x, y, 1, deco1);
        else if (r === 1) setTile(data, w, h, x, y, 1, deco2);
        else setTile(data, w, h, x, y, 1, deco3);
      }
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var dx3 = x - cx;
      var dy3 = y - cy;
      if (dx3 * dx3 + dy3 * dy3 <= clearR * clearR) {
        addRegionId(data, w, h, x, y, 0);
      } else {
        addRegionId(data, w, h, x, y, 1);
      }
    }
  }
}

function generateDungeon(data, w, h, stone, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, stone);

  var wallThick = 1;
  fillRect(data, w, h, 0, 0, w - 1, wallThick, 1, wallSide);
  fillRect(data, w, h, 0, h - 1 - wallThick, w - 1, h - 1, 1, wallSide);
  fillRect(data, w, h, 0, 0, wallThick, h - 1, 1, wallSide);
  fillRect(data, w, h, w - 1 - wallThick, 0, w - 1, h - 1, 1, wallSide);

  for (var x = 0; x < w; x++) {
    addShadowBits(data, w, h, x, wallThick + 1, 15);
  }

  var roomW = Math.max(3, Math.floor(w / 4));
  var roomH = Math.max(3, Math.floor(h / 3));
  var rooms = [
    { x1: 2, y1: 2, x2: 2 + roomW, y2: 2 + roomH },
    { x1: w - 3 - roomW, y1: 2, x2: w - 3, y2: 2 + roomH },
    { x1: Math.floor(w / 2) - Math.floor(roomW / 2), y1: h - 3 - roomH, x2: Math.floor(w / 2) + Math.floor(roomW / 2), y2: h - 3 }
  ];

  for (var ri = 0; ri < rooms.length; ri++) {
    var room = rooms[ri];
    fillRect(data, w, h, room.x1, room.y1, room.x1, room.y2, 1, 0);
    fillRect(data, w, h, room.x2, room.y1, room.x2, room.y2, 1, 0);
    fillRect(data, w, h, room.x1, room.y1, room.x2, room.y1, 1, 0);
    fillRect(data, w, h, room.x1, room.y2, room.x2, room.y2, 1, 0);

    setTile(data, w, h, room.x2, room.y1 + 1, 1, 0);
    setTile(data, w, h, room.x2, room.y1 + 2, 1, 0);

    for (var rx = room.x1; rx <= room.x2; rx++) {
      addShadowBits(data, w, h, rx, room.y1 + 1, 15);
    }
  }

  var corridorY1 = Math.floor(h / 2);
  for (var x = 2; x < w - 2; x++) {
    if (x !== Math.floor(w / 2)) {
      setTile(data, w, h, x, corridorY1 - 1, 1, wallSide);
      setTile(data, w, h, x, corridorY1 + 2, 1, wallSide);
    }
  }
  for (var x = 2; x < w - 2; x++) {
    addShadowBits(data, w, h, x, corridorY1 - 1 + 1 + 1, 15);
  }

  var deco = pickDeco(cfg, 3) || FALLBACK.rockB;
  var seed = 77;
  for (var ri = 0; ri < rooms.length; ri++) {
    var room = rooms[ri];
    for (var y = room.y1 + 2; y < room.y2 - 1; y += 2) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 3 === 0) {
        setTile(data, w, h, room.x1 + 1, y, 1, deco);
      }
    }
  }

  for (var ri = 0; ri < rooms.length; ri++) {
    var room = rooms[ri];
    for (var y = room.y1 + 1; y < room.y2; y++) {
      for (var x = room.x1 + 1; x < room.x2; x++) {
        addRegionId(data, w, h, x, y, 1);
      }
    }
  }
  if (rooms.length >= 3) {
    var bossRoom = rooms[2];
    for (var y = bossRoom.y1 + 1; y < bossRoom.y2; y++) {
      for (var x = bossRoom.x1 + 1; x < bossRoom.x2; x++) {
        addRegionId(data, w, h, x, y, 2);
      }
    }
  }
}

function generateTown(data, w, h, grass, dirt, roof, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, grass);

  var cx = Math.floor(w / 2);
  var cy = Math.floor(h / 2);
  var roadW = 2;

  for (var x = 0; x < w; x++) {
    for (var dy = 0; dy < roadW; dy++) {
      setTile(data, w, h, x, cy - 1 + dy, 0, dirt);
    }
  }
  for (var y = 0; y < h; y++) {
    for (var dx = 0; dx < roadW; dx++) {
      setTile(data, w, h, cx - 1 + dx, y, 0, dirt);
    }
  }

  for (var x = 2; x < w - 2; x += Math.floor(w / 5)) {
    for (var y = 2; y < h - 2; y += Math.floor(h / 4)) {
      if (Math.abs(x - cx) > 2 || Math.abs(y - cy) > 2) {
        for (var px = x; px < x + 2 && px < w; px++) {
          setTile(data, w, h, px, y, 0, dirt);
        }
      }
    }
  }

  var houses = [
    { x: 2, y: 2, bw: 4, bh: 3 },
    { x: w - 6, y: 2, bw: 4, bh: 3 },
    { x: 2, y: h - 5, bw: 3, bh: 3 }
  ];

  for (var hi = 0; hi < houses.length; hi++) {
    var house = houses[hi];
    if (house.x + house.bw >= w || house.y + house.bh >= h) continue;

    fillRect(data, w, h, house.x, house.y, house.x + house.bw - 1, house.y, 1, roof);
    fillRect(data, w, h, house.x, house.y + 1, house.x + house.bw - 1, house.y + house.bh - 1, 1, wallSide);

    addShadowBits(data, w, h, house.x, house.y + house.bh, 15);
    for (var sx = house.x; sx <= house.x + house.bw - 1; sx++) {
      addShadowBits(data, w, h, sx, house.y + house.bh, 15);
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 0);
    }
  }
}

function generateCastle(data, w, h, stone, wallSide, roof, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, stone);

  fillRect(data, w, h, 0, 0, w - 1, 1, 1, wallSide);
  fillRect(data, w, h, 0, h - 2, w - 1, h - 1, 1, wallSide);
  fillRect(data, w, h, 0, 0, 1, h - 1, 1, wallSide);
  fillRect(data, w, h, w - 2, 0, w - 1, h - 1, 1, wallSide);

  for (var x = 0; x < w; x++) {
    addShadowBits(data, w, h, x, 2, 15);
    addShadowBits(data, w, h, x, h - 3, 15);
  }

  var midX = Math.floor(w / 2);
  fillRect(data, w, h, midX - 1, 2, midX + 1, h - 3, 1, wallSide);

  for (var y = 2; y < h - 3; y++) {
    addShadowBits(data, w, h, midX - 2, y, 15);
    addShadowBits(data, w, h, midX + 2, y, 15);
  }

  setTile(data, w, h, midX, Math.floor(h / 2), 1, 0);
  setTile(data, w, h, midX, Math.floor(h / 2) + 1, 1, 0);

  var pillar = pickDeco(cfg, 4) || FALLBACK.pillarB;
  for (var y = 3; y < h - 3; y += 3) {
    setTile(data, w, h, 3, y, 1, pillar);
    setTile(data, w, h, w - 4, y, 1, pillar);
    if (midX - 1 > 4) setTile(data, w, h, midX - 3, y, 1, pillar);
    if (midX + 1 < w - 4) setTile(data, w, h, midX + 3, y, 1, pillar);
  }

  var throneRoom = { x1: midX + 2, y1: 2, x2: w - 3, y2: Math.floor(h / 2) - 1 };
  for (var y = throneRoom.y1 + 1; y <= throneRoom.y2; y++) {
    for (var x = throneRoom.x1 + 1; x <= throneRoom.x2; x++) {
      addRegionId(data, w, h, x, y, 2);
    }
  }
  for (var y = 3; y < h - 3; y++) {
    for (var x = 3; x < w - 3; x++) {
      if (x !== midX) addRegionId(data, w, h, x, y, 0);
    }
  }
}

function generateCave(data, w, h, dirt, water, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, dirt);

  var seed = 13;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var distEdge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (distEdge <= 1) {
        setTile(data, w, h, x, y, 1, wallSide);
      } else if (distEdge === 2) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        if (seed % 3 === 0) {
          setTile(data, w, h, x, y, 1, wallSide);
        }
      }
    }
  }

  for (var x = 0; x < w; x++) {
    addShadowBits(data, w, h, x, 2, 15);
    addShadowBits(data, w, h, x, h - 3, 15);
  }
  for (var y = 0; y < h; y++) {
    addShadowBits(data, w, h, 2, y, 15);
    addShadowBits(data, w, h, w - 3, y, 15);
  }

  if (w >= 10 && h >= 8) {
    var px = Math.floor(w * 0.7);
    var py = Math.floor(h * 0.3);
    setTile(data, w, h, px, py, 0, water);
    setTile(data, w, h, px + 1, py, 0, water);
    setTile(data, w, h, px, py + 1, 0, water);
    setTile(data, w, h, px + 1, py + 1, 0, water);
  }

  var stalac = pickDeco(cfg, 5) || FALLBACK.stumpB;
  var stalag = pickDeco(cfg, 6) || FALLBACK.rockB;
  seed = 31;
  for (var y = 3; y < h - 3; y += 3) {
    for (var x = 3; x < w - 3; x += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 4 === 0) {
        var deco = (seed % 2 === 0) ? stalac : stalag;
        setTile(data, w, h, x, y, 1, deco);
      }
    }
  }

  for (var y = 2; y < h - 2; y++) {
    for (var x = 2; x < w - 2; x++) {
      if (getTile(data, w, h, x, y, 1) === 0) {
        addRegionId(data, w, h, x, y, 1);
      }
    }
  }
}

function generateVillage(data, w, h, grass, dirt, roof, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, grass);

  var pathX = Math.floor(w / 3);
  var pathY = Math.floor(h / 2);
  for (var y = 0; y < h; y++) {
    for (var dx = 0; dx < 2; dx++) {
      var px = pathX + dx + Math.floor(Math.sin(y * 0.4) * 0.8);
      if (px >= 0 && px < w) setTile(data, w, h, px, y, 0, dirt);
    }
  }
  for (var x = pathX; x < w; x++) {
    for (var dy = 0; dy < 2; dy++) {
      setTile(data, w, h, x, pathY - 1 + dy, 0, dirt);
    }
  }

  var houses = [
    { x: pathX + 3, y: pathY - 4, bw: 3, bh: 2 },
    { x: pathX + 3, y: pathY + 2, bw: 3, bh: 2 },
    { x: Math.min(w - 5, pathX + 8), y: pathY - 3, bw: 3, bh: 2 }
  ];
  for (var hi = 0; hi < houses.length; hi++) {
    var house = houses[hi];
    if (house.x + house.bw >= w || house.y + house.bh >= h || house.x < 0 || house.y < 0) continue;
    fillRect(data, w, h, house.x, house.y, house.x + house.bw - 1, house.y, 1, roof);
    fillRect(data, w, h, house.x, house.y + 1, house.x + house.bw - 1, house.y + house.bh - 1, 1, wallSide);
    for (var sx = house.x; sx <= house.x + house.bw - 1; sx++) {
      addShadowBits(data, w, h, sx, house.y + house.bh, 15);
    }
  }

  var gardenFloor = pickGround(cfg, 'ground', dirt, 3);
  var gx = Math.floor(w / 2) + 2;
  var gy = Math.floor(h / 2);
  if (gx + 2 < w && gy + 2 < h) {
    fillRect(data, w, h, gx, gy, gx + 2, gy + 2, 0, gardenFloor);
  }

  var wellDeco = pickDeco(cfg, 7) || FALLBACK.pillarB;
  var wcx = Math.floor(w / 2);
  var wcy = Math.floor(h / 2);
  if (wcx < w && wcy < h) setTile(data, w, h, wcx, wcy, 1, wellDeco);

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 0);
    }
  }
}

function generateSwamp(data, w, h, grass, dirt, water, deepWater, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, water);

  var seed = 55;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var distEdge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (distEdge > 0 && seed % 3 !== 0) {
        var tile = (seed % 5 === 0) ? grass : dirt;
        setTile(data, w, h, x, y, 0, tile);
      }
    }
  }

  var deadTree = pickDeco(cfg, 8) || FALLBACK.stumpB;
  var rock = pickDeco(cfg, 9) || FALLBACK.rockB;
  seed = 88;
  for (var y = 2; y < h - 2; y += 3) {
    for (var x = 2; x < w - 2; x += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 5 === 0) {
        setTile(data, w, h, x, y, 1, deadTree);
      } else if (seed % 7 === 0) {
        setTile(data, w, h, x, y, 1, rock);
      }
    }
  }

  for (var y = 2; y < h - 2; y += 2) {
    var mx = Math.floor(w / 2);
    setTile(data, w, h, mx, y, 0, dirt);
    if (mx + 1 < w) setTile(data, w, h, mx + 1, y, 0, dirt);
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (getTile(data, w, h, x, y, 0) !== water && getTile(data, w, h, x, y, 0) !== deepWater) {
        addShadowBits(data, w, h, x, y, 15);
      }
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 1);
    }
  }
}

function generateDesert(data, w, h, dirt, water, cfg) {
  var sand = pickGround(cfg, 'ground', dirt, 4);
  if (!sand) sand = dirt;
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, sand);

  var rock = pickDeco(cfg, 10) || FALLBACK.rockB;
  var cactus = pickDeco(cfg, 11) || FALLBACK.stumpB;
  var seed = 22;
  for (var y = 1; y < h - 1; y += 3) {
    for (var x = 1; x < w - 1; x += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 6 === 0) {
        setTile(data, w, h, x, y, 1, rock);
      } else if (seed % 8 === 0) {
        setTile(data, w, h, x, y, 1, cactus);
      }
    }
  }

  var oX = Math.floor(w * 0.8);
  var oY = Math.floor(h * 0.8);
  var oR = Math.max(2, Math.floor(Math.min(w, h) / 6));
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var dx = x - oX;
      var dy = y - oY;
      if (dx * dx + dy * dy < oR * oR) {
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < oR * 0.5) {
          setTile(data, w, h, x, y, 0, water);
        } else {
          var shallowWater = pickGround(cfg, 'water', water, 2);
          setTile(data, w, h, x, y, 0, shallowWater || water);
        }
      }
    }
  }

  var palmTree = pickDeco(cfg, 12) || FALLBACK.treeB;
  if (oX - 1 >= 0) setTile(data, w, h, oX - 1, oY - 1, 1, palmTree);
  if (oX + 1 < w) setTile(data, w, h, oX + 1, oY - 1, 1, palmTree);

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 1);
    }
  }
}

function generateRuins(data, w, h, stone, dirt, wallSide, cfg) {
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, stone);

  var seed = 99;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 10 === 0) {
        setTile(data, w, h, x, y, 0, dirt);
      }
    }
  }

  var segments = [
    { x1: 0, y1: 0, x2: w - 1, y2: 1 },
    { x1: 0, y1: h - 2, x2: w - 1, y2: h - 1 },
    { x1: 0, y1: 0, x2: 1, y2: h - 1 },
    { x1: w - 2, y1: 0, x2: w - 1, y2: h - 1 }
  ];

  for (var si = 0; si < segments.length; si++) {
    var seg = segments[si];
    for (var y = seg.y1; y <= seg.y2; y++) {
      for (var x = seg.x1; x <= seg.x2; x++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        if (seed % 4 !== 0) {
          setTile(data, w, h, x, y, 1, wallSide);
        }
      }
    }
  }

  var interiorWalls = [
    { x1: Math.floor(w * 0.3), y1: 2, x2: Math.floor(w * 0.3), y2: Math.floor(h * 0.6) },
    { x1: Math.floor(w * 0.6), y1: Math.floor(h * 0.4), x2: Math.floor(w * 0.6), y2: h - 3 }
  ];
  for (var wi = 0; wi < interiorWalls.length; wi++) {
    var wall = interiorWalls[wi];
    for (var y = wall.y1; y <= wall.y2; y++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 3 !== 0) {
        setTile(data, w, h, wall.x1, y, 1, wallSide);
      }
    }
  }

  for (var x = 0; x < w; x++) {
    addShadowBits(data, w, h, x, 2, 15);
    addShadowBits(data, w, h, x, h - 3, 15);
  }

  var rubble = pickDeco(cfg, 13) || FALLBACK.rockB;
  var debris = pickDeco(cfg, 14) || FALLBACK.stumpB;
  seed = 44;
  for (var y = 2; y < h - 2; y += 2) {
    for (var x = 2; x < w - 2; x += 3) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 4 === 0) setTile(data, w, h, x, y, 1, rubble);
      else if (seed % 6 === 0) setTile(data, w, h, x, y, 1, debris);
    }
  }

  var vegetation = pickDeco(cfg, 15) || FALLBACK.bushB;
  seed = 66;
  for (var y = 3; y < h - 3; y += 4) {
    for (var x = 3; x < w - 3; x += 5) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 7 === 0) {
        setTile(data, w, h, x, y, 1, vegetation);
        setTile(data, w, h, x, y, 0, dirt);
      }
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 1);
    }
  }
}

function generateInterior(data, w, h, stone, wallSide, cfg) {
  var floor = pickGround(cfg, 'ground', stone, 3);
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, floor);

  fillRect(data, w, h, 0, 0, w - 1, 1, 1, wallSide);
  fillRect(data, w, h, 0, h - 2, w - 1, h - 1, 1, wallSide);
  fillRect(data, w, h, 0, 0, 1, h - 1, 1, wallSide);
  fillRect(data, w, h, w - 2, 0, w - 1, h - 1, 1, wallSide);

  for (var x = 2; x < w - 2; x++) {
    addShadowBits(data, w, h, x, 2, 15);
  }
  for (var y = 2; y < h - 2; y++) {
    addShadowBits(data, w, h, 2, y, 15);
    addShadowBits(data, w, h, w - 3, y, 15);
  }

  var doorX = Math.floor(w / 2);
  setTile(data, w, h, doorX, h - 2, 1, 0);
  setTile(data, w, h, doorX, h - 1, 1, 0);

  var carpet = pickGround(cfg, 'ground', floor, 4);
  var cx = Math.floor(w / 2);
  var cy = Math.floor(h / 2);
  var cw = Math.max(2, Math.floor(w / 4));
  var ch = Math.max(2, Math.floor(h / 4));
  fillRect(data, w, h, cx - cw, cy - ch, cx + cw, cy + ch, 0, carpet);

  var table = pickDeco(cfg, 16) || FALLBACK.pillarB;
  var bookshelf = pickDeco(cfg, 17) || FALLBACK.rockB;
  var chair = pickDeco(cfg, 18) || FALLBACK.stumpB;

  setTile(data, w, h, cx, cy, 1, table);
  setTile(data, w, h, cx - 1, cy, 1, chair);
  setTile(data, w, h, cx + 1, cy, 1, chair);

  setTile(data, w, h, 3, 3, 1, bookshelf);
  if (w > 10) setTile(data, w, h, 4, 3, 1, bookshelf);

  setTile(data, w, h, w - 4, 3, 1, bookshelf);

  for (var y = 2; y < h - 2; y++) {
    for (var x = 2; x < w - 2; x++) {
      addRegionId(data, w, h, x, y, 0);
    }
  }
}

function generateBeach(data, w, h, grass, dirt, water, deepWater, cfg) {
  var sand = pickGround(cfg, 'ground', dirt, 5);
  if (!sand) sand = dirt;
  fillRect(data, w, h, 0, 0, w - 1, h - 1, 0, sand);

  fillRect(data, w, h, 0, 0, w - 1, Math.floor(h * 0.4), 0, water);
  fillRect(data, w, h, 0, 0, w - 1, Math.floor(h * 0.25), 0, deepWater);

  for (var x = 0; x < w; x++) {
    var transY = Math.floor(h * 0.4) + Math.floor(Math.sin(x * 0.7) * 1.5);
    for (var y = transY; y < transY + 2 && y < h; y++) {
      var shallowWater = pickGround(cfg, 'water', water, 2);
      setTile(data, w, h, x, y, 0, shallowWater || water);
    }
  }

  for (var x = 0; x < w; x++) {
    var sandY = Math.floor(h * 0.4) + Math.floor(Math.sin(x * 0.7) * 1.5) + 2;
    if (sandY < h) {
      setTile(data, w, h, x, sandY, 0, sand);
    }
  }

  for (var y = Math.floor(h * 0.6); y < h; y++) {
    for (var x = 0; x < w; x++) {
      setTile(data, w, h, x, y, 0, grass);
    }
  }

  var palmTree = pickDeco(cfg, 12) || FALLBACK.treeB;
  var rock = pickDeco(cfg, 10) || FALLBACK.rockB;
  var seed = 11;
  for (var x = 2; x < w - 2; x += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    var py = Math.floor(h * 0.5) + (seed % 3);
    if (py < h) {
      if (seed % 3 === 0) setTile(data, w, h, x, py, 1, palmTree);
      else if (seed % 5 === 0) setTile(data, w, h, x, py, 1, rock);
    }
  }

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      addRegionId(data, w, h, x, y, 1);
    }
  }
}

module.exports = { generateTileLayoutV2 };

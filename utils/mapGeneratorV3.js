'use strict';

// ─── mapGeneratorV3.js — RPG Maker MV Procedural Map Generator V3 ───
// Features: Perlin noise 2D, BSP dungeon, cellular automata caves,
// parametric seed, 20+ themes, automatic event generation,
// correct 6-layer data format (layers 0-3 = tile IDs, 4 = shadow bits, 5 = region IDs)

// ════════════════════════════════════════════════════════════════
// PERLIN NOISE 2D (pure JS, no dependencies)
// ════════════════════════════════════════════════════════════════

function PerlinNoise(seed) {
    this.perm = new Uint8Array(512);
    this.grad = [
        [1,1],[-1,1],[1,-1],[-1,-1],
        [1,0],[-1,0],[0,1],[0,-1],
        [1,1],[-1,1],[1,-1],[-1,-1],
        [1,0],[-1,0],[0,1],[0,-1]
    ];
    var p = new Uint8Array(256);
    var s = seed || 0;
    for (var i = 0; i < 256; i++) p[i] = i;
    for (var i = 255; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        var j = s % (i + 1);
        var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (var i = 0; i < 512; i++) this.perm[i] = p[i & 255];
}

PerlinNoise.prototype.fade = function(t) { return t * t * t * (t * (t * 6 - 15) + 10); };
PerlinNoise.prototype.lerp = function(a, b, t) { return a + t * (b - a); };
PerlinNoise.prototype.dot2 = function(g, x, y) { return g[0] * x + g[1] * y; };

PerlinNoise.prototype.noise2d = function(x, y) {
    var X = Math.floor(x) & 255;
    var Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    var u = this.fade(x);
    var v = this.fade(y);
    var p = this.perm;
    var A = p[X] + Y;
    var B = p[X + 1] + Y;
    var g = this.grad;
    return this.lerp(
        this.lerp(this.dot2(g[p[A] & 15], x, y), this.dot2(g[p[B] & 15], x - 1, y), u),
        this.lerp(this.dot2(g[p[A + 1] & 15], x, y - 1), this.dot2(g[p[B + 1] & 15], x - 1, y - 1), u),
        v
    );
};

PerlinNoise.prototype.fbm = function(x, y, octaves, lacunarity, gain) {
    var sum = 0, amp = 1, freq = 1, max = 0;
    octaves = octaves || 4;
    lacunarity = lacunarity || 2.0;
    gain = gain || 0.5;
    for (var i = 0; i < octaves; i++) {
        sum += this.noise2d(x * freq, y * freq) * amp;
        max += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    return sum / max;
};

// ════════════════════════════════════════════════════════════════
// PRNG (Linear Congruential Generator)
// ════════════════════════════════════════════════════════════════

function PRNG(seed) {
    this.seed = seed || 42;
}
PRNG.prototype.next = function() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed;
};
PRNG.prototype.nextFloat = function() { return this.next() / 0x7fffffff; };
PRNG.prototype.nextInt = function(min, max) { return min + (this.next() % (max - min + 1)); };
PRNG.prototype.nextBool = function(chance) { return this.nextFloat() < (chance || 0.5); };

// ════════════════════════════════════════════════════════════════
// MAP DATA HELPERS (correct layer format)
// ════════════════════════════════════════════════════════════════
// Layer 0: Lower tile 1 (ground: A1, A2, A5)
// Layer 1: Lower tile 2 (ground overlay: A2, A5)
// Layer 2: Upper tile 1 (walls/roofs: A3, A4, B-E decorations)
// Layer 3: Upper tile 2 (extra decorations: B-E)
// Layer 4: Shadow bits (bitmask 0-15, NOT a tile ID)
// Layer 5: Region ID (1-255, NOT a tile ID)

var LAYER_GROUND1 = 0;
var LAYER_GROUND2 = 1;
var LAYER_UPPER1 = 2;
var LAYER_UPPER2 = 3;
var LAYER_SHADOW = 4;
var LAYER_REGION = 5;

function setTile(data, w, h, x, y, layer, tileId) {
    if (x >= 0 && x < w && y >= 0 && y < h && layer >= 0 && layer < 6)
        data[(layer * h + y) * w + x] = tileId;
}

function getTile(data, w, h, x, y, layer) {
    if (x < 0 || x >= w || y < 0 || y >= h || layer < 0 || layer >= 6) return 0;
    return data[(layer * h + y) * w + x];
}

function fillRect(data, w, h, x1, y1, x2, y2, layer, tileId) {
    for (var y = y1; y <= y2; y++)
        for (var x = x1; x <= x2; x++)
            setTile(data, w, h, x, y, layer, tileId);
}

function fillLayer(data, w, h, layer, tileId) {
    fillRect(data, w, h, 0, 0, w - 1, h - 1, layer, tileId);
}

function setShadow(data, w, h, x, y, bits) {
    if (x >= 0 && x < w && y >= 0 && y < h)
        data[(LAYER_SHADOW * h + y) * w + x] = data[(LAYER_SHADOW * h + y) * w + x] | bits;
}

function setRegion(data, w, h, x, y, rid) {
    if (x >= 0 && x < w && y >= 0 && y < h && rid >= 0 && rid <= 255)
        data[(LAYER_REGION * h + y) * w + x] = rid;
}

function makeAutotileId(kind, shape) { return 2048 + kind * 48 + (shape || 0); }

// ════════════════════════════════════════════════════════════════
// TILESET CONFIG: Per-tileset tile ID mappings
// ════════════════════════════════════════════════════════════════

var TILESETS = {
    overworld: {
        water: 2048, deepWater: makeAutotileId(1, 0),
        ground: makeAutotileId(16, 0), dirt: makeAutotileId(20, 0),
        forest: makeAutotileId(18, 0), mountain: makeAutotileId(24, 0),
        tree: 0, town: 2, castle: 4, port: 6
    },
    outside: {
        water: 2048, deepWater: makeAutotileId(1, 0),
        grass: 2816, dirt: makeAutotileId(8, 0), stone: makeAutotileId(6, 0),
        sand: makeAutotileId(10, 0), darkGrass: makeAutotileId(2, 0),
        lava: makeAutotileId(4, 0), swampWater: makeAutotileId(14, 0),
        wallSide: makeAutotileId(8, 0, 4352), wallTop: 4352,
        roof: 4352, roof2: makeAutotileId(1, 0, 4352), roof3: makeAutotileId(2, 0, 4352),
        tree: 1538, bush: 1539, flower: 1540, rock: 1541, pillar: 1536, stump: 1537,
        fence: 1542, well: 1543, barrel: 1544, crate: 1545,
        chest: 1546, sign: 1547, lamp: 1548, flower2: 1549,
        magicDeco: 512, magicDeco2: 513, magicDeco3: 514
    },
    inside: {
        floor: makeAutotileId(0, 0, 2816), carpet: makeAutotileId(2, 0, 2816),
        woodFloor: makeAutotileId(4, 0, 2816), tileFloor: makeAutotileId(6, 0, 2816),
        wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
        door: 1536, bookshelf: 1537, table: 1538, chair: 1539,
        bed: 1540, chest: 1541, pot: 1542, lamp: 1543,
        stairs: 1544, window: 1545, fireplace: 1546, cabinet: 1547,
        magicDeco: 512, magicDeco2: 513, magicDeco3: 514, magicDeco4: 768
    },
    dungeon: {
        floor: makeAutotileId(0, 0, 2816), darkFloor: makeAutotileId(2, 0, 2816),
        brickFloor: makeAutotileId(4, 0, 2816),
        wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
        wallDark: makeAutotileId(2, 0, 5888), wallStone: makeAutotileId(4, 0, 5888),
        water: 2048, lava: makeAutotileId(4, 0),
        pillar: 1536, rock: 1537, torch: 1538, chest: 1539,
        bones: 1540, crate: 1541, barrel: 1542, crystal: 1543
    },
    sf_outside: {
        water: 2048, grass: 2816, concrete: makeAutotileId(6, 0),
        metal: makeAutotileId(8, 0), asphalt: makeAutotileId(10, 0),
        wallSide: makeAutotileId(8, 0, 4352), wallTop: makeAutotileId(0, 0, 4352),
        roof: makeAutotileId(0, 0, 4352),
        lamp: 1536, sign: 1537, vehicle: 1538, container: 1539,
        antenna: 1540, satellite: 1541, fence: 1542, barrier: 1543,
        sifiDeco: 512, sifiDeco2: 513
    },
    sf_inside: {
        floor: makeAutotileId(0, 0, 2816), metalFloor: makeAutotileId(2, 0, 2816),
        tileFloor: makeAutotileId(4, 0, 2816),
        wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
        screen: 1536, console: 1537, locker: 1538, bed: 1539,
        table: 1540, chair: 1541, door: 1542, vent: 1543,
        sifiDeco: 512, sifiDeco2: 513
    },
    magic_exterior: {
        water: 2048, grass: 2816, dirt: makeAutotileId(8, 0), stone: makeAutotileId(6, 0),
        wallSide: makeAutotileId(8, 0, 4352), wallTop: 4352,
        roof: 4352, roof2: makeAutotileId(1, 0, 4352),
        tree: 1538, bush: 1539, flower: 1540, rock: 1541,
        magicTree: 512, magicCrystal: 513, magicRune: 514, magicArch: 515,
        magicPillar: 516, magicFountain: 517, magicTorch: 518, magicFlower: 519
    },
    space_interior: {
        floor: makeAutotileId(0, 0, 2816), metalFloor: makeAutotileId(2, 0, 2816),
        wallSide: makeAutotileId(0, 0, 5888), wallTop: makeAutotileId(1, 0, 5888),
        screen: 1536, console: 1537, locker: 1538, bed: 1539,
        table: 1540, chair: 1541, door: 1542, vent: 1543,
        sifiPanel: 512, sifiMonitor: 513, sifiTank: 514, sifiCore: 515
    }
};

// ════════════════════════════════════════════════════════════════
// BSP DUNGEON GENERATOR
// ════════════════════════════════════════════════════════════════

function BSPNode(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.left = null; this.right = null;
    this.room = null;
}

BSPNode.prototype.split = function(rng, minSize) {
    if (this.left || this.right) return false;
    var horizontal = rng.nextBool(0.5);
    if (this.w > this.h && this.w / this.h >= 1.25) horizontal = false;
    else if (this.h > this.w && this.h / this.w >= 1.25) horizontal = true;

    var max = (horizontal ? this.h : this.w) - minSize;
    if (max < minSize) return false;

    var split = rng.nextInt(minSize, max);
    if (horizontal) {
        this.left = new BSPNode(this.x, this.y, this.w, split);
        this.right = new BSPNode(this.x, this.y + split, this.w, this.h - split);
    } else {
        this.left = new BSPNode(this.x, this.y, split, this.h);
        this.right = new BSPNode(this.x + split, this.y, this.w - split, this.h);
    }
    return true;
};

BSPNode.prototype.createRooms = function(rng, minRoom, margin) {
    if (this.left || this.right) {
        if (this.left) this.left.createRooms(rng, minRoom, margin);
        if (this.right) this.right.createRooms(rng, minRoom, margin);
    } else {
        var rw = rng.nextInt(minRoom, Math.max(minRoom, this.w - margin * 2));
        var rh = rng.nextInt(minRoom, Math.max(minRoom, this.h - margin * 2));
        var rx = rng.nextInt(this.x + margin, Math.max(this.x + margin, this.x + this.w - rw - margin));
        var ry = rng.nextInt(this.y + margin, Math.max(this.y + margin, this.y + this.h - rh - margin));
        this.room = { x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) };
    }
};

BSPNode.prototype.getRooms = function() {
    if (this.room) return [this.room];
    var rooms = [];
    if (this.left) rooms = rooms.concat(this.left.getRooms());
    if (this.right) rooms = rooms.concat(this.right.getRooms());
    return rooms;
};

BSPNode.prototype.getCorridors = function(rng) {
    var corridors = [];
    if (this.left && this.right) {
        var lr = this.left.getRooms();
        var rr = this.right.getRooms();
        if (lr.length > 0 && rr.length > 0) {
            var a = lr[rng.nextInt(0, lr.length - 1)];
            var b = rr[rng.nextInt(0, rr.length - 1)];
            corridors.push({ x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy });
        }
        corridors = corridors.concat(this.left.getCorridors(rng));
        corridors = corridors.concat(this.right.getCorridors(rng));
    }
    return corridors;
};

function generateBSPDungeon(data, w, h, rng, ts, opts) {
    opts = opts || {};
    var depth = opts.depth || 4;
    var minRoom = opts.minRoom || 3;
    var margin = opts.margin || 1;
    var wallThick = opts.wallThick || 1;

    var floorTile = ts.floor || 2304;
    var wallTile = ts.wallSide || 5888;
    var wallTopTile = ts.wallTop || makeAutotileId(1, 0, 5888);

    fillRect(data, w, h, 0, 0, w - 1, h - 1, LAYER_GROUND1, wallTile);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++)
            setTile(data, w, h, x, y, LAYER_UPPER1, wallTopTile);

    var root = new BSPNode(wallThick, wallThick, w - wallThick * 2, h - wallThick * 2);
    for (var i = 0; i < depth; i++) {
        var leaves = getLeaves(root);
        for (var j = 0; j < leaves.length; j++) {
            leaves[j].split(rng, Math.max(3, Math.floor(Math.min(w, h) / (depth + 1))));
        }
    }
    root.createRooms(rng, minRoom, margin);

    var rooms = root.getRooms();
    var corridors = root.getCorridors(rng);

    for (var ri = 0; ri < rooms.length; ri++) {
        var r = rooms[ri];
        fillRect(data, w, h, r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, LAYER_GROUND1, floorTile);
        for (var ry = r.y; ry < r.y + r.h; ry++)
            for (var rx = r.x; rx < r.x + r.w; rx++) {
                setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
                setRegion(data, w, h, rx, ry, 1);
            }
    }

    for (var ci = 0; ci < corridors.length; ci++) {
        var c = corridors[ci];
        var cx = Math.min(c.x1, c.x2);
        var cy = Math.min(c.y1, c.y2);
        var cw = Math.abs(c.x2 - c.x1) + 1;
        var ch = Math.abs(c.y2 - c.y1) + 1;
        if (rng.nextBool()) {
            fillRect(data, w, h, cx, c.y1, cx + cw - 1, c.y1, LAYER_GROUND1, floorTile);
            fillRect(data, w, h, c.x2, cy, c.x2, cy + ch - 1, LAYER_GROUND1, floorTile);
        } else {
            fillRect(data, w, h, c.x1, cy, c.x1, cy + ch - 1, LAYER_GROUND1, floorTile);
            fillRect(data, w, h, cx, c.y2, cx + cw - 1, c.y2, LAYER_GROUND1, floorTile);
        }
        for (var py = cy; py < cy + ch; py++)
            for (var px = cx; px < cx + cw; px++) {
                if (getTile(data, w, h, px, py, LAYER_GROUND1) === floorTile) {
                    setTile(data, w, h, px, py, LAYER_UPPER1, 0);
                    setRegion(data, w, h, px, py, 1);
                }
            }
    }

    var decoTiles = [ts.pillar, ts.torch, ts.rock, ts.crystal, ts.bones, ts.barrel].filter(Boolean);
    for (var ri = 0; ri < rooms.length; ri++) {
        var r = rooms[ri];
        if (decoTiles.length > 0) {
            var numDeco = rng.nextInt(0, Math.min(4, Math.floor(r.w * r.h / 8)));
            for (var d = 0; d < numDeco; d++) {
                var dx = rng.nextInt(r.x + 1, r.x + r.w - 2);
                var dy = rng.nextInt(r.y + 1, r.y + r.h - 2);
                setTile(data, w, h, dx, dy, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
            }
        }
    }

    var bossRoom = rooms.length > 1 ? rooms[rooms.length - 1] : rooms[0];
    setRegion(data, w, h, bossRoom.cx, bossRoom.cy, 2);

    return { rooms: rooms, corridors: corridors, bossRoom: bossRoom };
}

function getLeaves(node) {
    if (!node.left && !node.right) return [node];
    var l = [];
    if (node.left) l = l.concat(getLeaves(node.left));
    if (node.right) l = l.concat(getLeaves(node.right));
    return l;
}

// ════════════════════════════════════════════════════════════════
// CELLULAR AUTOMATA CAVE GENERATOR
// ════════════════════════════════════════════════════════════════

function generateCellularCave(data, w, h, rng, ts, opts) {
    opts = opts || {};
    var fillProb = opts.fillProb || 0.45;
    var iterations = opts.iterations || 5;
    var birthLimit = opts.birthLimit || 4;
    var deathLimit = opts.deathLimit || 3;

    var floorTile = ts.floor || 2816;
    var wallTile = ts.wallSide || makeAutotileId(0, 0, 5888);
    var wallTopTile = ts.wallTop || makeAutotileId(1, 0, 5888);

    var grid = [];
    for (var y = 0; y < h; y++) {
        grid[y] = [];
        for (var x = 0; x < w; x++) {
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
                grid[y][x] = 1;
            else
                grid[y][x] = rng.nextFloat() < fillProb ? 1 : 0;
        }
    }

    for (var iter = 0; iter < iterations; iter++) {
        var newGrid = [];
        for (var y = 0; y < h; y++) {
            newGrid[y] = [];
            for (var x = 0; x < w; x++) {
                var neighbors = 0;
                for (var dy = -1; dy <= 1; dy++)
                    for (var dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        var nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) neighbors++;
                        else if (grid[ny][nx] === 1) neighbors++;
                    }
                if (grid[y][x] === 1)
                    newGrid[y][x] = neighbors < deathLimit ? 0 : 1;
                else
                    newGrid[y][x] = neighbors > birthLimit ? 1 : 0;
            }
        }
        grid = newGrid;
    }

    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            if (grid[y][x] === 0) {
                setTile(data, w, h, x, y, LAYER_GROUND1, floorTile);
                setTile(data, w, h, x, y, LAYER_UPPER1, 0);
                setRegion(data, w, h, x, y, 1);
            } else {
                setTile(data, w, h, x, y, LAYER_GROUND1, wallTile);
                setTile(data, w, h, x, y, LAYER_UPPER1, wallTopTile);
            }
        }

    var decoTiles = [ts.rock, ts.crystal, ts.stalactite, ts.bones, ts.torch].filter(Boolean);
    for (var y = 1; y < h - 1; y++)
        for (var x = 1; x < w - 1; x++) {
            if (grid[y][x] === 0 && decoTiles.length > 0 && rng.nextBool(0.06)) {
                setTile(data, w, h, x, y, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
            }
        }

    return { grid: grid };
}

// ════════════════════════════════════════════════════════════════
// THEME GENERATORS (20+ themes)
// ════════════════════════════════════════════════════════════════

function applyPerlinTerrain(data, w, h, perlin, ts, opts) {
    opts = opts || {};
    var scale = opts.scale || 0.08;
    var waterThreshold = opts.waterThreshold || -0.2;
    var deepThreshold = opts.deepThreshold || -0.4;
    var sandThreshold = opts.sandThreshold || -0.05;
    var waterTile = opts.waterTile || ts.water;
    var deepTile = opts.deepTile || ts.deepWater;
    var sandTile = opts.sandTile || ts.sand;
    var grassTile = opts.grassTile || ts.grass;

    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var n = perlin.fbm(x * scale, y * scale, 4);
            if (n < deepThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, deepTile);
            else if (n < waterThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, waterTile);
            else if (n < sandThreshold) setTile(data, w, h, x, y, LAYER_GROUND1, sandTile);
            else setTile(data, w, h, x, y, LAYER_GROUND1, grassTile);
        }
}

function generateForestTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    applyPerlinTerrain(data, w, h, perlin, ts, { scale: 0.06, waterThreshold: -0.25, deepThreshold: -0.45 });
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var g = getTile(data, w, h, x, y, LAYER_GROUND1);
            if (g === ts.grass && rng.nextBool(0.15))
                setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : (rng.nextBool() ? ts.bush : ts.flower));
            else if (g === ts.grass && rng.nextBool(0.03))
                setTile(data, w, h, x, y, LAYER_UPPER1, ts.rock);
            if (g === ts.water) setRegion(data, w, h, x, y, 3);
            else if (g === ts.grass) setRegion(data, w, h, x, y, 1);
        }
    var cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    var cr = Math.max(3, Math.floor(Math.min(w, h) / 5));
    for (var dy = -cr; dy <= cr; dy++)
        for (var dx = -cr; dx <= cr; dx++) {
            var rx = cx + dx, ry = cy + dy;
            if (dx * dx + dy * dy < cr * cr) {
                setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.dirt);
                setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
                setTile(data, w, h, rx, ry, LAYER_UPPER2, 0);
                setRegion(data, w, h, rx, ry, 1);
            }
        }
}

function generateTownTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.grass);
    var roadX = Math.floor(w / 2);
    var roadY = Math.floor(h / 2);
    fillRect(data, w, h, roadX - 1, 0, roadX + 1, h - 1, LAYER_GROUND1, ts.dirt);
    fillRect(data, w, h, 0, roadY - 1, w - 1, roadY + 1, LAYER_GROUND1, ts.dirt);
    setRegion(data, w, h, 0, 0, w - 1, h - 1, 1);
    var houses = [];
    var numHouses = Math.max(3, Math.floor(w * h / 150));
    for (var i = 0; i < numHouses; i++) {
        var hw = rng.nextInt(4, 6), hh = rng.nextInt(3, 5);
        var hx = rng.nextInt(2, w - hw - 2);
        var hy = rng.nextInt(2, h - hh - 2);
        if (Math.abs(hx + hw / 2 - roadX) < 4 && Math.abs(hy + hh / 2 - roadY) < 4) continue;
        var overlap = false;
        for (var j = 0; j < houses.length; j++) {
            var oh = houses[j];
            if (hx < oh.x + oh.w + 1 && hx + hw + 1 > oh.x && hy < oh.y + oh.h + 1 && hy + hh + 1 > oh.y) { overlap = true; break; }
        }
        if (overlap) continue;
        houses.push({ x: hx, y: hy, w: hw, h: hh });
        fillRect(data, w, h, hx, hy, hx + hw - 1, hy, LAYER_UPPER1, ts.roof);
        fillRect(data, w, h, hx, hy + 1, hx + hw - 1, hy + hh - 1, LAYER_UPPER1, ts.wallSide);
        var doorX = hx + Math.floor(hw / 2);
        setTile(data, w, h, doorX, hy + hh - 1, LAYER_UPPER1, 0);
        setTile(data, w, h, doorX, hy + hh - 1, LAYER_GROUND1, ts.dirt);
        for (var dy = hy; dy < hy + hh; dy++)
            for (var dx = hx; dx < hx + hw; dx++)
                setShadow(data, w, h, dx, dy, 15);
    }
    var decoTiles = [ts.well, ts.barrel, ts.sign, ts.lamp, ts.flower, ts.flower2];
    for (var i = 0; i < Math.floor(w * h / 40); i++) {
        var dx = rng.nextInt(0, w - 1), dy = rng.nextInt(0, h - 1);
        if (getTile(data, w, h, dx, dy, LAYER_UPPER1) === 0)
            setTile(data, w, h, dx, dy, LAYER_UPPER2, decoTiles[rng.nextInt(0, decoTiles.length - 1)]);
    }
    return { houses: houses };
}

function generateInteriorTheme(data, w, h, rng) {
    var ts = TILESETS.inside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.floor);
    fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, 0, w - 1, 0, LAYER_UPPER2, ts.wallTop);
    fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, 2, 0, h - 3, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, w - 1, 2, w - 1, h - 3, LAYER_UPPER1, ts.wallSide);
    var doorX = Math.floor(w / 2);
    setTile(data, w, h, doorX, h - 1, LAYER_UPPER1, 0);
    setTile(data, w, h, doorX - 1, h - 1, LAYER_UPPER1, 0);
    fillRect(data, w, h, 2, 2, w - 3, h - 3, LAYER_REGION, 0);
    setRegion(data, w, h, 2, 2, w - 3, h - 3, 1);
    var cw = Math.max(2, Math.floor(w / 4)), ch = Math.max(2, Math.floor(h / 4));
    var cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    fillRect(data, w, h, cx - Math.floor(cw / 2), cy - Math.floor(ch / 2), cx + Math.floor(cw / 2), cy + Math.floor(ch / 2), LAYER_GROUND1, ts.carpet);
    setTile(data, w, h, cx, cy, LAYER_UPPER2, ts.table);
    setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.chair);
    setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.chair);
    setTile(data, w, h, 2, 2, LAYER_UPPER2, ts.bookshelf);
    setTile(data, w, h, 3, 2, LAYER_UPPER2, ts.bookshelf);
    setTile(data, w, h, w - 3, 2, LAYER_UPPER2, ts.bed);
}

function generateCastleTheme(data, w, h, rng) {
    var ts = TILESETS.outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
    fillRect(data, w, h, 0, 0, w - 1, 2, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, 0, 0, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, w - 1, 0, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 1, 1, w - 2, h - 2, LAYER_REGION, 0);
    setRegion(data, w, h, 2, 2, w - 3, h - 3, 1);
    var midX = Math.floor(w / 2);
    fillRect(data, w, h, midX - 1, 3, midX + 1, h - 4, LAYER_UPPER1, 0);
    setTile(data, w, h, midX - 1, 3, LAYER_UPPER1, ts.wallSide);
    setTile(data, w, h, midX + 1, 3, LAYER_UPPER1, ts.wallSide);
    for (var y = 3; y < h - 3; y += 3) {
        setTile(data, w, h, 2, y, LAYER_UPPER2, ts.pillar);
        setTile(data, w, h, w - 3, y, LAYER_UPPER2, ts.pillar);
    }
    var throneX = Math.floor(w * 0.75), throneY = Math.floor(h * 0.25);
    setTile(data, w, h, throneX, throneY, LAYER_UPPER2, 1536);
    setRegion(data, w, h, throneX - 2, throneY - 2, throneX + 2, throneY + 2, 2);
    setTile(data, w, h, midX, h - 2, LAYER_UPPER1, 0);
    setTile(data, w, h, midX, h - 1, LAYER_UPPER1, 0);
}

function generateBeachTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    var waterLine = Math.floor(h * 0.4);
    var sandLine = Math.floor(h * 0.6);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var offset = Math.floor(Math.sin(x * 0.5) * 2);
            var ey = y + offset;
            if (ey < waterLine) {
                setTile(data, w, h, x, y, LAYER_GROUND1, ey < waterLine - 3 ? ts.deepWater : ts.water);
                setRegion(data, w, h, x, y, 3);
            } else if (ey < sandLine) {
                setTile(data, w, h, x, y, LAYER_GROUND1, ts.sand || ts.dirt);
                setRegion(data, w, h, x, y, 1);
            } else {
                setTile(data, w, h, x, y, LAYER_GROUND1, ts.grass);
                setRegion(data, w, h, x, y, 1);
            }
        }
    for (var i = 0; i < Math.floor(w * h / 60); i++) {
        var x = rng.nextInt(0, w - 1), y = rng.nextInt(sandLine, h - 1);
        if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
            setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : ts.rock);
    }
}

function generateDesertTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.sand || ts.dirt);
    var n = perlin.fbm(0, 0, 1);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.05, y * 0.05, 3);
            if (v > 0.35) setTile(data, w, h, x, y, LAYER_GROUND1, ts.stone);
            if (rng.nextBool(0.04))
                setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.rock : ts.stump);
            setRegion(data, w, h, x, y, 1);
        }
    var ox = Math.floor(w * 0.75), oy = Math.floor(h * 0.75);
    var or = Math.max(3, Math.floor(Math.min(w, h) / 6));
    for (var dy = -or; dy <= or; dy++)
        for (var dx = -or; dx <= or; dx++) {
            if (dx * dx + dy * dy < or * or) {
                var rx = ox + dx, ry = oy + dy;
                if (dx * dx + dy * dy < (or * 0.5) * (or * 0.5))
                    setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.deepWater);
                else
                    setTile(data, w, h, rx, ry, LAYER_GROUND1, ts.water);
                setTile(data, w, h, rx, ry, LAYER_UPPER1, 0);
                setRegion(data, w, h, rx, ry, 2);
            }
        }
    setTile(data, w, h, ox - 1, oy - or + 1, LAYER_UPPER1, ts.tree);
    setTile(data, w, h, ox + 1, oy - or + 1, LAYER_UPPER1, ts.tree);
}

function generateSwampTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.07, y * 0.07, 4);
            if (v < -0.1) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.swampWater || ts.water); setRegion(data, w, h, x, y, 3); }
            else if (v < 0.1) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt); setRegion(data, w, h, x, y, 1); setShadow(data, w, h, x, y, 15); }
            else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.darkGrass || ts.grass); setRegion(data, w, h, x, y, 1); setShadow(data, w, h, x, y, 15); }
        }
    for (var i = 0; i < Math.floor(w * h / 30); i++) {
        var x = rng.nextInt(0, w - 1), y = rng.nextInt(0, h - 1);
        if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0 && getTile(data, w, h, x, y, LAYER_GROUND1) !== ts.water)
            setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.stump : ts.rock);
    }
}

function generateRuinsTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.1, y * 0.1, 3);
            if (v > 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt);
        }
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && rng.nextBool(0.75))
                setTile(data, w, h, x, y, LAYER_UPPER1, ts.wallSide);
        }
    var wallXs = [Math.floor(w * 0.3), Math.floor(w * 0.6)];
    for (var wi = 0; wi < wallXs.length; wi++) {
        for (var y = 2; y < h - 2; y++) {
            if (rng.nextBool(0.65))
                setTile(data, w, h, wallXs[wi], y, LAYER_UPPER1, ts.wallSide);
        }
    }
    setRegion(data, w, h, 1, 1, w - 2, h - 2, 1);
    for (var i = 0; i < Math.floor(w * h / 25); i++) {
        var x = rng.nextInt(1, w - 2), y = rng.nextInt(1, h - 2);
        if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
            setTile(data, w, h, x, y, LAYER_UPPER2, rng.nextBool() ? ts.rock : (rng.nextBool() ? ts.bush : ts.stump));
    }
}

function generateVillageTheme(data, w, h, rng, perlin) {
    return generateTownTheme(data, w, h, rng, perlin);
}

function generateDungeonTheme(data, w, h, rng) {
    return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 15)), minRoom: 3, margin: 1 });
}

function generateCaveTheme(data, w, h, rng) {
    return generateCellularCave(data, w, h, rng, TILESETS.dungeon, { fillProb: 0.48, iterations: 5 });
}

function generateSnowTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.stone);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.06, y * 0.06, 4);
            if (v < -0.15) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.water); setRegion(data, w, h, x, y, 3); }
            else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.stone); setRegion(data, w, h, x, y, 1); }
        }
    for (var i = 0; i < Math.floor(w * h / 20); i++) {
        var x = rng.nextInt(0, w - 1), y = rng.nextInt(0, h - 1);
        if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0)
            setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : ts.rock);
    }
}

function generateHarborTheme(data, w, h, rng) {
    var ts = TILESETS.outside;
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            if (y < Math.floor(h * 0.35)) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.deepWater); setRegion(data, w, h, x, y, 3); }
            else if (y < Math.floor(h * 0.45)) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.water); setRegion(data, w, h, x, y, 3); }
            else { setTile(data, w, h, x, y, LAYER_GROUND1, ts.dirt); setRegion(data, w, h, x, y, 1); }
        }
    var dockY = Math.floor(h * 0.45);
    fillRect(data, w, h, Math.floor(w * 0.2), dockY, Math.floor(w * 0.8), dockY + 1, LAYER_GROUND1, ts.stone);
}

function generateVolcanoTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.dungeon;
    fillLayer(data, w, h, LAYER_GROUND1, ts.darkFloor || ts.floor);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.08, y * 0.08, 4);
            if (v < -0.3) { setTile(data, w, h, x, y, LAYER_GROUND1, ts.lava); setRegion(data, w, h, x, y, 4); }
            else if (rng.nextBool(0.04))
                setTile(data, w, h, x, y, LAYER_UPPER1, ts.rock);
            else setRegion(data, w, h, x, y, 1);
        }
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++)
            if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && rng.nextBool(0.8))
                setTile(data, w, h, x, y, LAYER_UPPER1, ts.wallStone || ts.wallSide);
}

function generateSewerTheme(data, w, h, rng) {
    return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(2, Math.floor(Math.min(w, h) / 18)), minRoom: 3, margin: 1 });
}

function generateFortressTheme(data, w, h, rng) {
    return generateBSPDungeon(data, w, h, rng, TILESETS.dungeon, { depth: Math.max(3, Math.floor(Math.min(w, h) / 12)), minRoom: 4, margin: 1 });
}

function generateMagicForestTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.magic_exterior;
    applyPerlinTerrain(data, w, h, perlin, ts, { scale: 0.05, waterThreshold: -0.3 });
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var g = getTile(data, w, h, x, y, LAYER_GROUND1);
            if (g === ts.grass && rng.nextBool(0.12))
                setTile(data, w, h, x, y, LAYER_UPPER1, rng.nextBool() ? ts.tree : (rng.nextBool() ? ts.magicTree : ts.magicFlower));
            else if (g === ts.grass && rng.nextBool(0.04))
                setTile(data, w, h, x, y, LAYER_UPPER1, ts.magicCrystal);
            setRegion(data, w, h, x, y, g === ts.water ? 3 : 1);
        }
    var cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    setTile(data, w, h, cx, cy, LAYER_UPPER2, ts.magicRune);
    setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.magicPillar);
    setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.magicPillar);
    setRegion(data, w, h, cx - 3, cy - 3, cx + 3, cy + 3, 2);
}

function generateMagicInteriorTheme(data, w, h, rng) {
    var ts = TILESETS.inside;
    generateInteriorTheme(data, w, h, rng);
    var cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    setTile(data, w, h, cx, cy - 2, LAYER_UPPER2, ts.magicDeco || 512);
    setTile(data, w, h, cx + 2, cy, LAYER_UPPER2, ts.magicDeco2 || 513);
    setTile(data, w, h, cx - 2, cy, LAYER_UPPER2, ts.magicDeco3 || 514);
}

function generateSpaceInteriorTheme(data, w, h, rng) {
    var ts = TILESETS.space_interior;
    fillLayer(data, w, h, LAYER_GROUND1, ts.metalFloor);
    fillRect(data, w, h, 0, 0, w - 1, 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, h - 1, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, 0, 0, 0, h - 1, LAYER_UPPER1, ts.wallSide);
    fillRect(data, w, h, w - 1, 0, w - 1, h - 1, LAYER_UPPER1, ts.wallSide);
    setRegion(data, w, h, 1, 1, w - 2, h - 2, 1);
    var doorX = Math.floor(w / 2);
    setTile(data, w, h, doorX, h - 1, LAYER_UPPER1, 0);
    var deco = [ts.console, ts.screen, ts.locker, ts.sifiPanel, ts.sifiMonitor, ts.sifiTank, ts.sifiCore];
    deco = deco.filter(Boolean);
    for (var i = 0; i < Math.floor(w * h / 20); i++) {
        var x = rng.nextInt(2, w - 3), y = rng.nextInt(2, h - 3);
        if (getTile(data, w, h, x, y, LAYER_UPPER1) === 0 && deco.length > 0)
            setTile(data, w, h, x, y, LAYER_UPPER2, deco[rng.nextInt(0, deco.length - 1)]);
    }
}

function generateSpaceExteriorTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.sf_outside;
    fillLayer(data, w, h, LAYER_GROUND1, ts.metal);
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.1, y * 0.1, 3);
            if (v > 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.asphalt);
            else if (v < -0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.concrete);
            setRegion(data, w, h, x, y, 1);
        }
    var deco = [ts.antenna, ts.satellite, ts.container, ts.vehicle, ts.sifiDeco, ts.sifiDeco2];
    deco = deco.filter(Boolean);
    for (var i = 0; i < Math.floor(w * h / 30); i++) {
        var x = rng.nextInt(1, w - 2), y = rng.nextInt(1, h - 2);
        if (deco.length > 0) setTile(data, w, h, x, y, LAYER_UPPER1, deco[rng.nextInt(0, deco.length - 1)]);
    }
}

function generateWorldTheme(data, w, h, rng, perlin) {
    var ts = TILESETS.overworld;
    for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
            var v = perlin.fbm(x * 0.03, y * 0.03, 5, 2.0, 0.5);
            if (v < -0.3) setTile(data, w, h, x, y, LAYER_GROUND1, ts.deepWater);
            else if (v < -0.1) setTile(data, w, h, x, y, LAYER_GROUND1, ts.water);
            else if (v < 0.05) setTile(data, w, h, x, y, LAYER_GROUND1, ts.ground);
            else if (v < 0.2) setTile(data, w, h, x, y, LAYER_GROUND1, ts.forest);
            else setTile(data, w, h, x, y, LAYER_GROUND1, ts.mountain);
        }
}

// ════════════════════════════════════════════════════════════════
// EVENT GENERATION
// ════════════════════════════════════════════════════════════════

function generateEvents(w, h, rng, theme, opts) {
    opts = opts || {};
    var events = [null];
    var addEvents = opts.addEvents !== false;
    if (!addEvents) return events;

    var teleportPositions = [];
    if (opts.transferPoints) {
        for (var i = 0; i < opts.transferPoints.length; i++) {
            var tp = opts.transferPoints[i];
            teleportPositions.push(tp);
        }
    }

    if (theme === 'dungeon' || theme === 'cave' || theme === 'fortress' || theme === 'sewer' || theme === 'volcano') {
        var numChests = rng.nextInt(1, 3);
        for (var i = 0; i < numChests; i++) {
            var cx = rng.nextInt(3, w - 4), cy = rng.nextInt(3, h - 4);
            events.push(makeChestEvent(events.length, cx, cy));
        }
        var bossX = Math.floor(w * 0.75), bossY = Math.floor(h * 0.25);
        events.push(makeBossEvent(events.length, bossX, bossY, 1));
    }

    if (theme === 'town' || theme === 'village') {
        var npcNames = ['Merchant', 'Guard', 'Elder', 'Child', 'Traveler', 'Scholar', 'Blacksmith', 'Healer'];
        var numNpcs = rng.nextInt(2, 5);
        for (var i = 0; i < numNpcs; i++) {
            var nx = rng.nextInt(3, w - 4), ny = rng.nextInt(3, h - 4);
            events.push(makeNpcEvent(events.length, nx, ny, npcNames[i % npcNames.length]));
        }
    }

    if (theme === 'interior' || theme === 'magic_interior' || theme === 'space_interior') {
        events.push(makeNpcEvent(events.length, Math.floor(w / 2) + 1, Math.floor(h / 2), 'Inhabitant'));
    }

    for (var i = 0; i < teleportPositions.length; i++) {
        var tp = teleportPositions[i];
        events.push(makeTransferEvent(events.length, tp.x, tp.y, tp.destMapId, tp.destX, tp.destY, tp.trigger || 1));
    }

    return events;
}

function makeNpcEvent(id, x, y, name) {
    return {
        id: id, name: name || 'NPC', note: '', x: x, y: y,
        pages: [{
            conditions: defaultConditions(), directionFix: false,
            image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
            list: [
                { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
                { code: 401, indent: 0, parameters: ['...'] },
                { code: 0, indent: 0, parameters: [] }
            ],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 1, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
        }]
    };
}

function makeChestEvent(id, x, y) {
    return {
        id: id, name: 'Chest', note: '', x: x, y: y,
        pages: [{
            conditions: defaultConditions(), directionFix: true,
            image: { characterIndex: 0, characterName: 'Chest', direction: 2, pattern: 0, tileId: 0 },
            list: [
                { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
                { code: 401, indent: 0, parameters: ['Found treasure!'] },
                { code: 123, indent: 0, parameters: ['A', 1] },
                { code: 0, indent: 0, parameters: [] }
            ],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
        }, {
            conditions: Object.assign({}, defaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
            directionFix: true,
            image: { characterIndex: 0, characterName: 'Chest', direction: 2, pattern: 1, tileId: 0 },
            list: [{ code: 0, indent: 0, parameters: [] }],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
        }]
    };
}

function makeBossEvent(id, x, y, troopId) {
    return {
        id: id, name: 'Boss', note: '', x: x, y: y,
        pages: [{
            conditions: defaultConditions(), directionFix: true,
            image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
            list: [
                { code: 301, indent: 0, parameters: [0, troopId || 1, 0, 1] },
                { code: 601, indent: 0, parameters: [] },
                { code: 123, indent: 1, parameters: ['A', 1] },
                { code: 0, indent: 1, parameters: [] },
                { code: 602, indent: 0, parameters: [] },
                { code: 0, indent: 1, parameters: [] },
                { code: 603, indent: 0, parameters: [] },
                { code: 353, indent: 1, parameters: [] },
                { code: 0, indent: 1, parameters: [] },
                { code: 0, indent: 0, parameters: [] }
            ],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: false
        }, {
            conditions: Object.assign({}, defaultConditions(), { selfSwitchCh: 'A', selfSwitchValid: true }),
            directionFix: true,
            image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
            list: [{ code: 0, indent: 0, parameters: [] }],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: 0, walkAnime: false
        }]
    };
}

function makeTransferEvent(id, x, y, destMapId, destX, destY, trigger) {
    return {
        id: id, name: 'Transfer to Map' + destMapId, note: '', x: x, y: y,
        pages: [{
            conditions: defaultConditions(), directionFix: false,
            image: { characterIndex: 0, characterName: '', direction: 2, pattern: 1, tileId: 0 },
            list: [
                { code: 201, indent: 0, parameters: [0, destMapId, destX, destY, 0, 0] },
                { code: 0, indent: 0, parameters: [] }
            ],
            moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
            moveSpeed: 2, moveType: 0, priorityType: 0, stepAnime: false, through: true, trigger: trigger || 1, walkAnime: false
        }]
    };
}

function defaultConditions() {
    return { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: 'A', selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 };
}

// ════════════════════════════════════════════════════════════════
// MAIN ENTRY: generateTileLayoutV3
// ════════════════════════════════════════════════════════════════

var THEMES = [
    'forest', 'town', 'village', 'castle', 'dungeon', 'cave',
    'beach', 'desert', 'swamp', 'ruins', 'interior',
    'snow', 'harbor', 'volcano', 'sewer', 'fortress',
    'magic_forest', 'magic_interior', 'space_interior', 'space_exterior',
    'world'
];

function generateTileLayoutV3(width, height, theme, opts) {
    opts = opts || {};
    var seed = opts.seed || Math.floor(Math.random() * 2147483647);
    var rng = new PRNG(seed);
    var perlin = new PerlinNoise(seed);
    var data = new Array(width * height * 6).fill(0);

    var themeMap = {
        'forest': generateForestTheme,
        'town': generateTownTheme,
        'village': generateVillageTheme,
        'castle': generateCastleTheme,
        'dungeon': generateDungeonTheme,
        'cave': generateCaveTheme,
        'beach': generateBeachTheme,
        'desert': generateDesertTheme,
        'swamp': generateSwampTheme,
        'ruins': generateRuinsTheme,
        'interior': generateInteriorTheme,
        'snow': generateSnowTheme,
        'harbor': generateHarborTheme,
        'volcano': generateVolcanoTheme,
        'sewer': generateSewerTheme,
        'fortress': generateFortressTheme,
        'magic_forest': generateMagicForestTheme,
        'magic_interior': generateMagicInteriorTheme,
        'space_interior': generateSpaceInteriorTheme,
        'space_exterior': generateSpaceExteriorTheme,
        'world': generateWorldTheme
    };

    var genFn = themeMap[theme];
    if (genFn) {
        if (genFn.length >= 5)
            genFn(data, width, height, rng, perlin);
        else
            genFn(data, width, height, rng);
    } else {
        fillLayer(data, width, height, LAYER_GROUND1, 2816);
    }

    var events = generateEvents(width, height, rng, theme, opts);

    return {
        data: data,
        events: events,
        seed: seed,
        theme: theme,
        width: width,
        height: height
    };
}

module.exports = { generateTileLayoutV3, THEMES, TILESETS, PerlinNoise, PRNG };

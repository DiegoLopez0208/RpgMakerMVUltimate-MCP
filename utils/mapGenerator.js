/**
 * mapGenerator.js — Procedural Tile Layout Generation by Theme
 *
 * Generates a tile data array for a new RPG Maker MV map based on a theme.
 * MV stores tile data in a flat array of length: width * height * 6
 * (6 layers: layer 0 = ground, layer 1 = ground2/decoration,
 *  layer 2 = shadow, layer 3 = region, layers 4-5 = unused)
 *
 * Tile index formula: (layer * height + y) * width + x
 *
 * Tile IDs reference the standard RPG Maker MV RTP tileset (Overworld tileset A):
 * - Tile ID 0 = empty (no tile placed)
 * - A2 autotiles start at 2048 (grass area in default Outside tileset)
 * - A3 autotiles start at 2816 (roof/building area)
 * - A4 autotiles start at 4352 (wall/floor in Inside tileset)
 * - B-page tiles start at 1536 (first decorative page)
 * - C-page tiles start at 2048 (second decorative page)
 *
 * For the standard "Outside" tileset (tilesetId 1 or 2):
 * - Tile 2816 = A3 grass base (green grass autotile)
 * - Tile 2304 = A4 stone floor (gray stone autotile)
 * - Tile 2048 = A2 dark grass/dirt
 * - Tile 2576 = A2 dirt/earth autotile
 * - Tile 4608 = A4 wall tile (dark stone wall)
 * - Tile 5184 = A4 cave wall (rock wall)
 * - Tile 1536 = B-page tree/decoration start
 * - Tile 1538 = B-page tree top
 */

/**
 * Generate a tile data array based on the given theme.
 * @param {number} width - Map width in tiles
 * @param {number} height - Map height in tiles
 * @param {string} theme - Theme name: forest, dungeon, town, castle, cave
 * @returns {{ data: number[] }} Object with the tile data array
 */
function generateTileLayout(width, height, theme) {
  // Initialize the data array with all zeros (empty tiles)
  // 6 layers: ground(0), ground2(1), shadow(2), region(3), unused(4), unused(5)
  const data = new Array(width * height * 6).fill(0);

  /**
   * Set a tile at the given position and layer.
   * @param {number} x - X coordinate (0-based)
   * @param {number} y - Y coordinate (0-based)
   * @param {number} layer - Layer index (0-5)
   * @param {number} tileId - Tile ID to place
   */
  function setTile(x, y, layer, tileId) {
    if (x >= 0 && x < width && y >= 0 && y < height && layer >= 0 && layer < 6) {
      const index = (layer * height + y) * width + x;
      data[index] = tileId;
    }
  }

  /**
   * Fill a rectangle area on a given layer with a tile ID.
   */
  function fillRect(x1, y1, x2, y2, layer, tileId) {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        setTile(x, y, layer, tileId);
      }
    }
  }

  switch (theme) {
    case 'forest': {
      // Layer 0: Grass base tile covering the entire map
      // Tile 2816 = A3 grass autotile (lush green grass)
      fillRect(0, 0, width - 1, height - 1, 0, 2816);

      // Layer 1: Tree autotiles along the border cells (natural forest edge)
      // Tile 1538 = B-page tree decoration (large tree top)
      // Top and bottom borders
      for (let x = 0; x < width; x++) {
        setTile(x, 0, 1, 1538);           // Top row: tree line
        setTile(x, height - 1, 1, 1538);  // Bottom row: tree line
      }
      // Left and right borders
      for (let y = 0; y < height; y++) {
        setTile(0, y, 1, 1538);           // Left column: tree line
        setTile(width - 1, y, 1, 1538);  // Right column: tree line
      }
      // Add some scattered trees in the interior for natural feel
      // Tile 1539 = B-page small bush/shrub
      for (let y = 3; y < height - 3; y += 4) {
        for (let x = 3; x < width - 3; x += 5) {
          setTile(x, y, 1, 1539);  // Scattered shrubs
        }
      }
      break;
    }

    case 'dungeon': {
      // Layer 0: Stone floor covering the entire map
      // Tile 2304 = A4 stone floor autotile (gray dungeon floor)
      fillRect(0, 0, width - 1, height - 1, 0, 2304);

      // Layer 1: Dark wall tiles on the perimeter (dungeon walls)
      // Tile 4608 = A4 dark stone wall (dungeon wall block)
      for (let x = 0; x < width; x++) {
        setTile(x, 0, 1, 4608);           // Top wall
        setTile(x, 1, 1, 4608);           // Top wall thickness (2 tiles)
        setTile(x, height - 1, 1, 4608);  // Bottom wall
      }
      for (let y = 0; y < height; y++) {
        setTile(0, y, 1, 4608);           // Left wall
        setTile(width - 1, y, 1, 4608);  // Right wall
      }
      break;
    }

    case 'town': {
      // Layer 0: Grass base covering the entire map
      // Tile 2816 = A3 grass autotile (town grass)
      fillRect(0, 0, width - 1, height - 1, 0, 2816);

      // Layer 0: Dirt road in a center cross pattern (overwrites grass)
      // Tile 2576 = A2 dirt/earth autotile (brown dirt path)
      var centerX = Math.floor(width / 2);
      var centerY = Math.floor(height / 2);
      var roadWidth = 2; // Road is 2 tiles wide

      // Horizontal road
      for (let x = 0; x < width; x++) {
        for (let dy = -Math.floor(roadWidth / 2); dy <= Math.floor(roadWidth / 2); dy++) {
          var ry = centerY + dy;
          if (ry >= 0 && ry < height) {
            setTile(x, ry, 0, 2576);
          }
        }
      }

      // Vertical road
      for (let y = 0; y < height; y++) {
        for (let dx = -Math.floor(roadWidth / 2); dx <= Math.floor(roadWidth / 2); dx++) {
          var rx = centerX + dx;
          if (rx >= 0 && rx < width) {
            setTile(rx, y, 0, 2576);
          }
        }
      }
      break;
    }

    case 'castle': {
      // Layer 0: Stone floor throughout the castle interior
      // Tile 2304 = A4 stone floor autotile (castle floor)
      fillRect(0, 0, width - 1, height - 1, 0, 2304);

      // Layer 1: Wall tiles on the border (castle walls)
      // Tile 4608 = A4 wall block (gray castle wall)
      for (let x = 0; x < width; x++) {
        setTile(x, 0, 1, 4608);           // Top wall
        setTile(x, 1, 1, 4608);           // Top wall (double thickness)
        setTile(x, height - 1, 1, 4608);  // Bottom wall
      }
      for (let y = 0; y < height; y++) {
        setTile(0, y, 1, 4608);           // Left wall
        setTile(width - 1, y, 1, 4608);  // Right wall
      }

      // Add corner pillars for a castle feel
      // Tile 1536 = B-page first tile (decorative pillar/object)
      setTile(2, 2, 1, 1536);
      setTile(width - 3, 2, 1, 1536);
      setTile(2, height - 3, 1, 1536);
      setTile(width - 3, height - 3, 1, 1536);
      break;
    }

    case 'cave': {
      // Layer 0: Dirt floor throughout the cave
      // Tile 2576 = A2 dirt/earth autotile (cave dirt floor)
      fillRect(0, 0, width - 1, height - 1, 0, 2576);

      // Layer 1: Rock walls on the perimeter
      // Tile 5184 = A4 cave rock wall (rough stone wall)
      for (let x = 0; x < width; x++) {
        setTile(x, 0, 1, 5184);           // Top wall
        setTile(x, 1, 1, 5184);           // Top wall (double thickness for depth)
        setTile(x, height - 1, 1, 5184);  // Bottom wall
      }
      for (let y = 0; y < height; y++) {
        setTile(0, y, 1, 5184);           // Left wall
        setTile(width - 1, y, 1, 5184);  // Right wall
      }

      // Add some rock formations in the interior for cave feel
      // Tile 1537 = B-page rock/stalactite decoration
      for (let y = 4; y < height - 4; y += 5) {
        for (let x = 4; x < width - 4; x += 6) {
          setTile(x, y, 1, 1537);
        }
      }
      break;
    }

    default: {
      // Default: empty map (all tiles = 0)
      // No modifications needed since data is already filled with 0
      break;
    }
  }

  return { data };
}

module.exports = { generateTileLayout };

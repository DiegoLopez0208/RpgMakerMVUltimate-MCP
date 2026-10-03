import {
  Actor,
  Enemy,
  Tileset,
  Troop,
  CommonEvent,
  MapData,
  MapEvent,
  SystemData,
  AudioFile,
  Vehicle,
  EventCommand,
  MoveRoute,
} from '../utils/types.js';

/**
 * A single asset-filename-integrity finding. Warn-by-default (like {@link
 * ReferenceWarning}): it never blocks a write, it tells the caller that a record
 * points at an image/audio file that isn't present in the project — a dangling
 * *filename* the engine only discovers at runtime, throwing e.g.
 * "Failed to load img/enemies/Mudcrab.png" when the asset is first used.
 * `category` groups findings by the kind of field; `path` locates it.
 */
export interface AssetWarning {
  category: string;
  path: string;
  message: string;
}

/**
 * The available asset basenames per asset type (extension-stripped, exactly as
 * the engine references them). Built from `list_assets` — a type that's absent
 * or maps to an empty set is treated as "can't verify" (its whole directory is
 * empty or missing), so references against it are skipped rather than flagged
 * (matching the per-record warn-by-default convention that never false-positives
 * on an unused asset kind). Keyed by the same `AssetType` strings `list_assets`
 * uses.
 */
export type AvailableAssets = Partial<Record<string, Set<string>>>;

/**
 * The loaded project data the asset linter scans. `maps` carries the full {@link
 * MapData} (needed for the map-level bgm/bgs/parallax/battleback fields *and* the
 * event command lists). Kept as plain data so {@link checkAssets} stays pure and
 * unit-testable without file I/O.
 */
export interface AssetProjectData {
  actors: (Actor | null)[];
  enemies: (Enemy | null)[];
  tilesets: (Tileset | null)[];
  maps: Array<{ id: number; map: MapData }>;
  troops: (Troop | null)[];
  commonEvents: (CommonEvent | null)[];
  system: SystemData | null;
  animations?: (MvAnimationAssets | null)[];
}

/** MV uses two sprite sheets and per-timing SE, unlike MZ's effectName format. */
export interface MvAnimationAssets {
  id: number;
  animation1Name?: string;
  animation2Name?: string;
  timings?: Array<{ se?: AudioFile }>;
}

/** Folder each asset type lives in, for a legible warning message. */
const ASSET_FOLDER: Record<string, string> = {
  characters: 'img/characters',
  faces: 'img/faces',
  sv_actors: 'img/sv_actors',
  enemies: 'img/enemies',
  sv_enemies: 'img/sv_enemies',
  tilesets: 'img/tilesets',
  titles1: 'img/titles1',
  titles2: 'img/titles2',
  battlebacks1: 'img/battlebacks1',
  battlebacks2: 'img/battlebacks2',
  parallaxes: 'img/parallaxes',
  pictures: 'img/pictures',
  animations: 'img/animations',
  bgm: 'audio/bgm',
  bgs: 'audio/bgs',
  me: 'audio/me',
  se: 'audio/se',
};

// Event command codes that carry an asset-filename reference.
const CMD_SHOW_TEXT = 101; // parameters[0] = faceName
const CMD_SET_MOVEMENT_ROUTE = 205;
const CMD_SHOW_PICTURE = 231; // parameters[1] = picture name
const CMD_PLAY_BGM = 241;
const CMD_PLAY_BGS = 245;
const CMD_PLAY_ME = 249;
const CMD_PLAY_SE = 250;
const CMD_CHANGE_ACTOR_IMAGES = 322; // [actorId, charName, charIdx, faceName, faceIdx, battlerName]

/**
 * Record one asset reference to verify. A blank name (no asset set — the common
 * "none" case) or an unverifiable type (its directory is empty/missing) is
 * skipped, so only a genuinely dangling filename is flagged.
 */
function checkAsset(
  assets: AvailableAssets,
  type: string,
  name: unknown,
  category: string,
  path: string,
  warnings: AssetWarning[],
): void {
  if (typeof name !== 'string' || name === '') return;
  const available = assets[type];
  if (!available || available.size === 0) return; // can't verify -> don't flag
  if (!available.has(name)) {
    warnings.push({
      category,
      path,
      message: `references "${name}", which is missing from ${ASSET_FOLDER[type] ?? type}`,
    });
  }
}

/** Scan one event command list for asset-filename references. */
function checkCommandList(
  list: EventCommand[] | undefined,
  path: string,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  if (!Array.isArray(list)) return;
  list.forEach((cmd, i) => {
    if (!cmd || !Array.isArray(cmd.parameters)) return;
    const at = `${path} / command ${i}`;
    const p = cmd.parameters;
    switch (cmd.code) {
      case CMD_SET_MOVEMENT_ROUTE:
        checkMoveRoute(p[1] as MoveRoute, `${at} / moveRoute`, assets, warnings);
        break;
      case CMD_SHOW_TEXT:
        checkAsset(assets, 'faces', p[0], 'event-command', `${at} (Show Text face)`, warnings);
        break;
      case CMD_SHOW_PICTURE:
        checkAsset(assets, 'pictures', p[1], 'event-command', `${at} (Show Picture)`, warnings);
        break;
      case CMD_PLAY_BGM:
        checkAsset(assets, 'bgm', (p[0] as AudioFile)?.name, 'event-command', `${at} (Play BGM)`, warnings); // prettier-ignore
        break;
      case CMD_PLAY_BGS:
        checkAsset(assets, 'bgs', (p[0] as AudioFile)?.name, 'event-command', `${at} (Play BGS)`, warnings); // prettier-ignore
        break;
      case CMD_PLAY_ME:
        checkAsset(assets, 'me', (p[0] as AudioFile)?.name, 'event-command', `${at} (Play ME)`, warnings); // prettier-ignore
        break;
      case CMD_PLAY_SE:
        checkAsset(assets, 'se', (p[0] as AudioFile)?.name, 'event-command', `${at} (Play SE)`, warnings); // prettier-ignore
        break;
      case CMD_CHANGE_ACTOR_IMAGES:
        checkAsset(assets, 'characters', p[1], 'event-command', `${at} (Change Actor Images: character)`, warnings); // prettier-ignore
        checkAsset(assets, 'faces', p[3], 'event-command', `${at} (Change Actor Images: face)`, warnings); // prettier-ignore
        checkAsset(assets, 'sv_actors', p[5], 'event-command', `${at} (Change Actor Images: battler)`, warnings); // prettier-ignore
        break;
    }
  });
}

/** Forced routes and autonomous page routes share the same asset-bearing steps. */
function checkMoveRoute(
  route: MoveRoute | undefined,
  path: string,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  if (!Array.isArray(route?.list)) return;
  route.list.forEach((step, index) => {
    if (!step || !Array.isArray(step.parameters)) return;
    const at = `${path} / step ${index}`;
    if (step.code === 41) {
      checkAsset(assets, 'characters', step.parameters[0], 'move-route', `${at} (Change Image)`, warnings);
    } else if (step.code === 44) {
      checkAsset(assets, 'se', (step.parameters[0] as AudioFile)?.name, 'move-route', `${at} (Play SE)`, warnings);
    }
  });
}

function checkAnimations(data: AssetProjectData, assets: AvailableAssets, warnings: AssetWarning[]): void {
  data.animations?.forEach((animation) => {
    if (!animation) return;
    const at = `animation ${animation.id}`;
    checkAsset(assets, 'animations', animation.animation1Name, 'animation', `${at} / animation1Name`, warnings);
    checkAsset(assets, 'animations', animation.animation2Name, 'animation', `${at} / animation2Name`, warnings);
    if (Array.isArray(animation.timings)) {
      animation.timings.forEach((timing, index) => {
        checkAsset(assets, 'se', timing?.se?.name, 'animation', `${at} / timings[${index}] / se`, warnings);
      });
    }
  });
}

/** Actor sprite/face/side-view-battler filenames. */
function checkActors(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  data.actors.forEach((actor) => {
    if (!actor) return;
    checkAsset(assets, 'characters', actor.characterName, 'actor', `actor ${actor.id} / characterName`, warnings); // prettier-ignore
    checkAsset(assets, 'faces', actor.faceName, 'actor', `actor ${actor.id} / faceName`, warnings);
    checkAsset(assets, 'sv_actors', actor.battlerName, 'actor', `actor ${actor.id} / battlerName`, warnings); // prettier-ignore
  });
}

/**
 * Enemy battler filenames (the Mudcrab case). MV loads enemy battlers from
 * `img/sv_enemies` when `System.optSideView` is on and from `img/enemies`
 * otherwise, so the name is checked against the folder the engine will actually
 * read. A name missing there but present in the *other* folder is flagged even
 * if the right folder is empty/missing — the asset set is evidently present, the
 * file is just in the wrong place — with a hint naming where it was found.
 */
function checkEnemies(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  const sideView = data.system?.optSideView === true;
  const type = sideView ? 'sv_enemies' : 'enemies';
  const other = sideView ? 'enemies' : 'sv_enemies';
  data.enemies.forEach((enemy) => {
    if (!enemy) return;
    const name = enemy.battlerName;
    const path = `enemy ${enemy.id} / battlerName`;
    if (
      typeof name === 'string' &&
      name !== '' &&
      !assets[type]?.has(name) &&
      assets[other]?.has(name)
    ) {
      warnings.push({
        category: 'enemy',
        path,
        message: `references "${name}", which is missing from ${ASSET_FOLDER[type]} (found in ${ASSET_FOLDER[other]}, but the project is ${sideView ? 'side-view' : 'front-view'})`,
      });
      return;
    }
    checkAsset(assets, type, name, 'enemy', path, warnings);
  });
}

/** Tileset image sheet filenames (the 9 tilesetNames slots). */
function checkTilesets(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  data.tilesets.forEach((tileset) => {
    if (!tileset || !Array.isArray(tileset.tilesetNames)) return;
    tileset.tilesetNames.forEach((name, slot) => {
      checkAsset(assets, 'tilesets', name, 'tileset', `tileset ${tileset.id} / tilesetNames[${slot}]`, warnings); // prettier-ignore
    });
  });
}

/** Map-level audio/images plus every event page graphic and command list. */
function checkMaps(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  for (const { id, map } of data.maps) {
    const base = `map ${id}`;
    checkAsset(assets, 'bgm', map.bgm?.name, 'map', `${base} / bgm`, warnings);
    checkAsset(assets, 'bgs', map.bgs?.name, 'map', `${base} / bgs`, warnings);
    checkAsset(assets, 'parallaxes', map.parallaxName, 'map', `${base} / parallaxName`, warnings);
    checkAsset(assets, 'battlebacks1', map.battleback1Name, 'map', `${base} / battleback1Name`, warnings); // prettier-ignore
    checkAsset(assets, 'battlebacks2', map.battleback2Name, 'map', `${base} / battleback2Name`, warnings); // prettier-ignore

    map.events?.forEach((event: MapEvent | null) => {
      if (!event || !Array.isArray(event.pages)) return;
      event.pages.forEach((page, pi) => {
        const at = `${base} / event ${event.id} / page ${pi}`;
        checkAsset(assets, 'characters', page?.image?.characterName, 'event', `${at} / image`, warnings); // prettier-ignore
        checkCommandList(page?.list, at, assets, warnings);
        checkMoveRoute(page?.moveRoute, `${at} / moveRoute`, assets, warnings);
      });
    });
  }
}

/** Common-event and troop battle-event command lists. */
function checkEventLists(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  data.commonEvents.forEach((ce) => {
    if (ce) checkCommandList(ce.list, `common event ${ce.id}`, assets, warnings);
  });
  data.troops.forEach((troop) => {
    if (!troop || !Array.isArray(troop.pages)) return;
    troop.pages.forEach((page, pi) =>
      checkCommandList(page?.list, `troop ${troop.id} / page ${pi}`, assets, warnings),
    );
  });
}

/** System title/battleback images, default battle audio, and vehicle graphics/bgm. */
function checkSystem(
  data: AssetProjectData,
  assets: AvailableAssets,
  warnings: AssetWarning[],
): void {
  const s = data.system;
  if (!s) return;
  checkAsset(assets, 'titles1', s.title1Name, 'system', 'System.title1Name', warnings);
  checkAsset(assets, 'titles2', s.title2Name, 'system', 'System.title2Name', warnings);
  checkAsset(
    assets,
    'battlebacks1',
    s.battleback1Name,
    'system',
    'System.battleback1Name',
    warnings,
  );
  checkAsset(
    assets,
    'battlebacks2',
    s.battleback2Name,
    'system',
    'System.battleback2Name',
    warnings,
  );

  const audio: Array<[keyof SystemData, string, string]> = [
    ['titleBgm', 'bgm', 'System.titleBgm'],
    ['battleBgm', 'bgm', 'System.battleBgm'],
    ['victoryMe', 'me', 'System.victoryMe'],
    ['defeatMe', 'me', 'System.defeatMe'],
    ['gameoverMe', 'me', 'System.gameoverMe'],
  ];
  for (const [field, type, path] of audio) {
    checkAsset(assets, type, (s[field] as AudioFile)?.name, 'system', path, warnings);
  }

  if (Array.isArray(s.sounds)) {
    s.sounds.forEach((se, i) => {
      checkAsset(assets, 'se', se?.name, 'system', `System.sounds[${i}]`, warnings);
    });
  }

  const vehicles: Array<[keyof SystemData, string]> = [
    ['boat', 'System.boat'],
    ['ship', 'System.ship'],
    ['airship', 'System.airship'],
  ];
  for (const [field, path] of vehicles) {
    const v = s[field] as Vehicle | undefined;
    if (!v) continue;
    checkAsset(assets, 'characters', v.characterName, 'system', `${path}.characterName`, warnings);
    checkAsset(assets, 'bgm', v.bgm?.name, 'system', `${path}.bgm`, warnings);
  }
}

/**
 * Audit supported static asset-*filename* fields across the project against the files
 * actually present (see {@link AvailableAssets}). Pure and warn-by-default:
 * returns a list of dangling filename references (a `battlerName`/`characterName`/
 * `faceName`, a map bgm/bgs/parallax/battleback, a tileset sheet, an event Play
 * Audio / Show Picture / Show Text face, a system title/battleback/sound, …) that
 * point at a missing file — empty when everything resolves. The *id*-integrity
 * sibling is {@link checkReferences}.
 */
export function checkAssets(data: AssetProjectData, assets: AvailableAssets): AssetWarning[] {
  const warnings: AssetWarning[] = [];
  checkActors(data, assets, warnings);
  checkEnemies(data, assets, warnings);
  checkTilesets(data, assets, warnings);
  checkAnimations(data, assets, warnings);
  checkMaps(data, assets, warnings);
  checkEventLists(data, assets, warnings);
  checkSystem(data, assets, warnings);
  return warnings;
}

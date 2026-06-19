export interface RpgMakerDbEntry {
  id: number;
  name: string;
  note?: string;
  [key: string]: unknown;
}

export interface EventCommand {
  code: number;
  indent?: number;
  parameters: unknown[];
}

export interface EventPageCondition {
  actorId: number;
  actorValid: boolean;
  itemId: number;
  itemValid: boolean;
  selfSwitchCh: string;
  selfSwitchValid: boolean;
  switch1Id: number;
  switch1Valid: boolean;
  switch2Id: number;
  switch2Valid: boolean;
  variableId: number;
  variableValid: boolean;
  variableValue: number;
}

export interface EventPageImage {
  characterIndex: number;
  characterName: string;
  direction: number;
  pattern: number;
  tileId: number;
}

export interface MoveRoute {
  list: EventCommand[];
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
}

export interface EventPage {
  conditions: EventPageCondition;
  directionFix: boolean;
  image: EventPageImage;
  list: EventCommand[];
  moveFrequency: number;
  moveRoute: MoveRoute;
  moveSpeed: number;
  moveType: number;
  priorityType: number;
  stepAnime: boolean;
  through: boolean;
  trigger: number;
  walkAnime: boolean;
}

export interface MapEvent {
  id: number;
  name: string;
  note: string;
  x: number;
  y: number;
  pages: EventPage[];
}

export interface RpgMakerMap {
  autoplayBgm: boolean;
  autoplayBgs: boolean;
  battleback1Name: string;
  battleback2Name: string;
  bgm: { name: string; pan: number; pitch: number; volume: number };
  bgs: { name: string; pan: number; pitch: number; volume: number };
  data: number[];
  disableDashing: boolean;
  displayName: string;
  encounterList: unknown[];
  encounterStep: number;
  events: (MapEvent | null)[];
  height: number;
  note: string;
  parallaxLoopX: boolean;
  parallaxLoopY: boolean;
  parallaxName: string;
  parallaxShow: boolean;
  parallaxSx: number;
  parallaxSy: number;
  scrollType: number;
  specifyBattleback: boolean;
  tilesetId: number;
  width: number;
}

export interface ActorParams {
  name?: string;
  nickname?: string;
  classId?: number;
  initialLevel?: number;
  maxLevel?: number;
  characterName?: string;
  characterIndex?: number;
  faceName?: string;
  faceIndex?: number;
  battlerName?: string;
  battlerHue?: number;
  equips?: number[];
  profile?: string;
  note?: string;
  traits?: unknown[];
}

export interface ItemParams {
  name?: string;
  description?: string;
  iconIndex?: number;
  itypeId?: number;
  price?: number;
  consumable?: boolean;
  scope?: number;
  occasion?: number;
  animationId?: number;
  effects?: unknown[];
  note?: string;
  traits?: unknown[];
}

export interface WeaponParams {
  name?: string;
  description?: string;
  iconIndex?: number;
  wtypeId?: number;
  price?: number;
  atk?: number;
  params?: number[];
  traits?: unknown[];
  etypeId?: number;
  animationId?: number;
  note?: string;
}

export interface ArmorParams {
  name?: string;
  description?: string;
  iconIndex?: number;
  atypeId?: number;
  price?: number;
  def?: number;
  params?: number[];
  traits?: unknown[];
  etypeId?: number;
  note?: string;
}

export interface SkillParams {
  name?: string;
  description?: string;
  iconIndex?: number;
  mpCost?: number;
  tpCost?: number;
  scope?: number;
  occasion?: number;
  speed?: number;
  successRate?: number;
  repeats?: number;
  tpGain?: number;
  hitType?: number;
  animationId?: number;
  damage?: { type: number; elementId: number; formula: string; variance: number; critical: boolean };
  message1?: string;
  message2?: string;
  messageType?: number;
  requiredWtypeId1?: number;
  requiredWtypeId2?: number;
  stypeId?: number;
  effects?: unknown[];
  note?: string;
  traits?: unknown[];
}

export interface ClassParams {
  name?: string;
  params?: number[][];
  expParams?: number[];
  learnings?: { level: number; skillId: number; note: string }[];
  traits?: unknown[];
  note?: string;
}

export interface EnemyParams {
  name?: string;
  battlerName?: string;
  battlerHue?: number;
  exp?: number;
  gold?: number;
  params?: number[];
  dropItems?: { kind: number; dataId: number; denominator: number }[];
  actions?: { skillId: number; conditionType: number; conditionParam1: number; conditionParam2: number; rating: number }[];
  note?: string;
  traits?: unknown[];
}

export interface BossEnemyParams extends EnemyParams {
  hpMultiplier?: number;
  atkMultiplier?: number;
  defMultiplier?: number;
  specialSkillId?: number;
}

export interface StateParams {
  name?: string;
  iconIndex?: number;
  priority?: number;
  restriction?: number;
  removeAtBattleEnd?: boolean;
  removeByDamage?: boolean;
  removeByRestriction?: boolean;
  autoRemovalTiming?: number;
  minTurns?: number;
  maxTurns?: number;
  stepsToRemove?: number;
  message1?: string;
  message2?: string;
  message3?: string;
  message4?: string;
  motion?: number;
  overlay?: number;
  traits?: unknown[];
  note?: string;
}

export interface TroopParams {
  name?: string;
  members?: { enemyId: number; x: number; y: number; hidden: boolean }[];
  pages?: unknown[];
  note?: string;
}

export interface CommonEventParams {
  name?: string;
  trigger?: number;
  switchId?: number;
  list?: EventCommand[];
  note?: string;
}

export interface TilesetParams {
  name?: string;
  mode?: number;
  tilesetNames?: string[];
  flags?: number[];
  note?: string;
}

export interface CreateMapParams {
  tileset_id?: number;
  tilesetId?: number;
  name?: string;
  theme?: string;
  width?: number;
  height?: number;
  scroll_type?: number;
  specify_battleback?: boolean;
  battleback1_name?: string;
  battleback2_name?: string;
  autoplay_bgm?: boolean;
  bgm_name?: string;
  bgm_pan?: number;
  bgm_pitch?: number;
  bgm_volume?: number;
  autoplay_bgs?: boolean;
  bgs_name?: string;
  bgs_pan?: number;
  bgs_pitch?: number;
  bgs_volume?: number;
  disable_dashing?: boolean;
  encounter_step?: number;
  parallax_name?: string;
  parallax_show?: boolean;
  parallax_loop_x?: boolean;
  parallax_loop_y?: boolean;
  parallax_sx?: number;
  parallax_sy?: number;
  display_name?: string;
  displayName?: string;
  note?: string;
  bgmName?: string;
  addEvents?: boolean;
  transferPoints?: unknown[];
  parentId?: number;
  seed?: number;
}

export interface CreateMapV3Params extends CreateMapParams {
  theme?: string;
  seed?: number;
  templateId?: number;
  useTemplate?: boolean;
  encounters?: boolean;
  enterableHouses?: boolean;
}

export interface SheetInfo {
  filename: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  tileCount?: number;
  kinds?: number;
  autotile?: boolean;
}

export interface TilesetConfig {
  ground: number;
  water: number;
  dirt: number;
  grass: number;
  sand: number;
  snow: number;
  wallSide: number;
  wallTop: number;
  roof: number;
  decoration: number;
  deepWater?: number;
  lava?: number;
  ice?: number;
  woodenFloor?: number;
  stoneFloor?: number;
  carpet?: number;
  metalFloor?: number;
  path?: number;
  bridge?: number;
  stairs?: number;
  [key: string]: number | undefined;
}

export interface GeneratorOptions {
  seed?: number;
  scale?: number;
  waterThreshold?: number;
  depth?: number;
  minRoom?: number;
  margin?: number;
  tileAlias?: string;
  tilesetConfig?: TilesetConfig;
  fillProb?: number;
  birthLimit?: number;
  deathLimit?: number;
  iterations?: number;
  [key: string]: unknown;
}

export interface MapTemplate {
  id: number;
  filename: string;
  displayName: string;
  category: string;
  theme: string;
  width: number;
  height: number;
  tilesetId: number;
}

export interface MapData {
  width: number;
  height: number;
  tilesetId: number;
  displayName: string;
  data: number[];
  events: (MapEvent | null)[];
  scrollType: number;
  autoplayBgm: boolean;
  autoplayBgs: boolean;
  battleback1Name: string;
  battleback2Name: string;
  bgm: { name: string; pan: number; pitch: number; volume: number };
  bgs: { name: string; pan: number; pitch: number; volume: number };
  disableDashing: boolean;
  encounterList: unknown[];
  encounterStep: number;
  note: string;
  parallaxLoopX: boolean;
  parallaxLoopY: boolean;
  parallaxName: string;
  parallaxShow: boolean;
  parallaxSx: number;
  parallaxSy: number;
  specifyBattleback: boolean;
}

export type VisionApiResponse = {
  image_path: string;
  analysis: string;
  model: string;
  tokens_used: {
    prompt: number;
    completion: number;
    total: number;
  };
};

export type AsciiMapResult = {
  mapId: number;
  mapName: string;
  width: number;
  height: number;
  tilesetId: number;
  layer: number;
  ascii: string;
  legend: string[];
  events: { id: number; name: string; x: number; y: number; marker: string }[];
  regionAscii?: string;
};

export type SelfSwitchKey = 'A' | 'B' | 'C' | 'D';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ItemType = 'item' | 'weapon' | 'armor';

export type ProjectSummary = {
  projectPath: string;
  dataFiles: Record<string, { type: string; total?: number; entries?: number; keys?: number; error?: string }>;
  gameTitle?: string;
  startMapId?: number;
  startX?: number;
  startY?: number;
  switchCount?: number;
  variableCount?: number;
  mapCount?: number;
  systemError?: string;
};

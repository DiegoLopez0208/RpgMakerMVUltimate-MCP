/**
 * Type definitions for RPG Maker MV data structures
 */

export interface Actor {
  id: number;
  name: string;
  nickname: string;
  profile: string;
  classId: number;
  initialLevel: number;
  maxLevel: number;
  characterName: string;
  characterIndex: number;
  faceName: string;
  faceIndex: number;
  battlerName: string;
  traits: Trait[];
  equips: number[];
  note: string;
}

export interface Item {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  itypeId: number;
  scope: number;
  occasion: number;
  speed: number;
  successRate: number;
  repeats: number;
  tpGain: number;
  hitType: number;
  animationId: number;
  price: number;
  consumable: boolean;
  damage: Damage;
  effects: Effect[];
  note: string;
}

export interface Skill {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  stypeId: number;
  mpCost: number;
  tpCost: number;
  scope: number;
  occasion: number;
  speed: number;
  successRate: number;
  repeats: number;
  tpGain: number;
  hitType: number;
  animationId: number;
  damage: Damage;
  effects: Effect[];
  note: string;
  message1: string;
  message2: string;
  requiredWtypeId1: number;
  requiredWtypeId2: number;
}

export interface Weapon {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  wtypeId: number;
  price: number;
  params: number[];
  traits: Trait[];
  etypeId: number;
  animationId: number;
  note: string;
}

export interface Armor {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  atypeId: number;
  price: number;
  params: number[];
  traits: Trait[];
  etypeId: number;
  note: string;
}

export interface Enemy {
  id: number;
  name: string;
  battlerName: string;
  battlerHue: number;
  params: number[];
  exp: number;
  gold: number;
  dropItems: DropItem[];
  actions: EnemyAction[];
  traits: Trait[];
  note: string;
}

/**
 * A character class (`data/Classes.json`): the param growth curves, learnable
 * skills, and traits that back an actor. The file is a 1-indexed array (slot 0
 * null, index === id).
 */
export interface GameClass {
  id: number;
  name: string;
  /** EXP curve settings: [basis, extra, accelerationA, accelerationB]. */
  expParams: number[];
  /**
   * Parameter growth: 8 rows (`[maxHP, maxMP, atk, def, mat, mdf, agi, luk]`),
   * each a `maxLevel + 1`-length curve indexed by level (index 0 is an unused
   * level-0 placeholder; the engine only reads level ≥ 1).
   */
  params: number[][];
  learnings: Learning[];
  traits: Trait[];
  note: string;
}

/** One "learn skill at level" entry in a class's `learnings` list. */
export interface Learning {
  level: number;
  skillId: number;
  note: string;
}

/**
 * A common event (`data/CommonEvents.json`): a named, reusable event-command
 * `list` that any map/battle event can invoke (command code 117) or that the
 * engine runs on its own via `trigger`. The file is a 1-indexed array (slot 0
 * null, index === id).
 */
export interface CommonEvent {
  id: number;
  name: string;
  /** The command list, same `EventCommand` format map events use; ends with code 0. */
  list: EventCommand[];
  /** Switch that gates an Autorun/Parallel common event (ignored when trigger is 0). */
  switchId: number;
  /** When it runs on its own: 0 None (call-only), 1 Autorun, 2 Parallel. */
  trigger: number;
}

/**
 * A state (`data/States.json`): a status condition (Poison, Sleep, Dead, …) that
 * can be applied to a battler by skills/items/traits. The file is a 1-indexed
 * array (slot 0 null, index === id). States are referenced by skill/item effects
 * (e.g. `create_state_skill`) and by traits, so an id must exist to be usable.
 */
export interface State {
  id: number;
  name: string;
  /** Behavior restriction: 0 none, 1 attack enemy, 2 attack anyone, 3 attack ally, 4 cannot move. */
  restriction: number;
  /** Display priority when several states share an icon slot (higher wins), 0-100. */
  priority: number;
  /** SV-actor motion played while afflicted (0 normal, 1 abnormal, 2 sleep, 3 dead, …). */
  motion: number;
  /** Overlay animation index drawn over the battler (0 = none). */
  overlay: number;
  /** Remove automatically when the battle ends. */
  removeAtBattleEnd: boolean;
  /** Remove when the battler's restriction changes. */
  removeByRestriction: boolean;
  /** Auto-removal timing: 0 none, 1 at action end, 2 at turn end. */
  autoRemovalTiming: number;
  /** Minimum duration in turns when auto-removed. */
  minTurns: number;
  /** Maximum duration in turns when auto-removed. */
  maxTurns: number;
  /** Remove when the battler takes damage. */
  removeByDamage: boolean;
  /** Chance (%) of removal per damage instance when `removeByDamage`. */
  chanceByDamage: number;
  /** Remove after walking a number of steps (on the map). */
  removeByWalking: boolean;
  /** Steps to walk off the state when `removeByWalking`. */
  stepsToRemove: number;
  /** Whether damage can release the state (MZ addition alongside removeByDamage). */
  releaseByDamage: boolean;
  /** Icon shown on the battler/status (0 = none). */
  iconIndex: number;
  /** Message when an actor gains the state. */
  message1: string;
  /** Message when an enemy gains the state. */
  message2: string;
  /** Message when the state persists. */
  message3: string;
  /** Message when the state is removed. */
  message4: string;
  /** Which battler's message form to use (engine's message routing). */
  traits: Trait[];
  note: string;
}

export interface Trait {
  code: number;
  dataId: number;
  value: number;
}

export interface Effect {
  code: number;
  dataId: number;
  value1: number;
  value2: number;
}

export interface Damage {
  type: number;
  elementId: number;
  formula: string;
  variance: number;
  critical: boolean;
}

export interface DropItem {
  kind: number;
  dataId: number;
  denominator: number;
}

export interface EnemyAction {
  skillId: number;
  conditionType: number;
  conditionParam1: number;
  conditionParam2: number;
  rating: number;
}

/**
 * A troop (`data/Troops.json`): a battle group of enemy `members` plus optional
 * battle-event `pages`. The file is a 1-indexed array (slot 0 null, index === id).
 */
export interface Troop {
  id: number;
  name: string;
  members: TroopMember[];
  pages: TroopPage[];
}

/** One placed enemy in a troop; `enemyId` references `data/Enemies.json`. */
export interface TroopMember {
  enemyId: number;
  x: number;
  y: number;
  hidden: boolean;
}

/**
 * A troop battle-event page: the same event-command `list` format map events use,
 * gated by battle-specific `conditions` and repeated per `span` (0 battle / 1 turn
 * / 2 moment). Note the conditions carry `enemyIndex` (troop slot), not an id.
 */
export interface TroopPage {
  conditions: TroopPageConditions;
  list: EventCommand[];
  span: number;
}

export interface TroopPageConditions {
  actorHp: number;
  actorId: number;
  actorValid: boolean;
  enemyHp: number;
  enemyIndex: number;
  enemyValid: boolean;
  switchId: number;
  switchValid: boolean;
  turnA: number;
  turnB: number;
  turnEnding: boolean;
  turnValid: boolean;
}

export interface MapData {
  autoplayBgm: boolean;
  autoplayBgs: boolean;
  battleback1Name: string;
  battleback2Name: string;
  bgm: AudioFile;
  bgs: AudioFile;
  disableDashing: boolean;
  displayName: string;
  encounterList: Encounter[];
  encounterStep: number;
  height: number;
  width: number;
  parallaxLoopX: boolean;
  parallaxLoopY: boolean;
  parallaxName: string;
  parallaxShow: boolean;
  parallaxSx: number;
  parallaxSy: number;
  scrollType: number;
  specifyBattleback: boolean;
  tilesetId: number;
  note: string;
  data: number[];
  events: (MapEvent | null)[];
}

/**
 * An entry in `data/MapInfos.json` — the map tree the editor displays. The file
 * is a 1-indexed array (slot 0 is `null`) whose index matches the map's `id`.
 * `parentId` 0 means a top-level map; `order` sequences siblings in the tree;
 * `scrollX`/`scrollY` are the editor's remembered scroll position (cosmetic).
 */
export interface MapInfo {
  id: number;
  name: string;
  parentId: number;
  order: number;
  expanded: boolean;
  scrollX: number;
  scrollY: number;
}

export interface MapEvent {
  id: number;
  name: string;
  note: string;
  pages: EventPage[];
  x: number;
  y: number;
}

export interface EventPage {
  conditions: EventConditions;
  directionFix: boolean;
  image: EventImage;
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

export interface EventConditions {
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

export interface EventImage {
  characterIndex: number;
  characterName: string;
  direction: number;
  pattern: number;
  tileId: number;
}

export interface EventCommand {
  code: number;
  indent: number;
  parameters: unknown[];
}

export interface MoveRoute {
  list: MoveCommand[];
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
}

export interface MoveCommand {
  code: number;
  parameters: unknown[];
}

export interface AudioFile {
  name: string;
  pan: number;
  pitch: number;
  volume: number;
}

export interface Encounter {
  regionSet: number[];
  troopId: number;
  weight: number;
}

export interface SystemData {
  airship: Vehicle;
  armorTypes: string[];
  attackMotions: AttackMotion[];
  battleBgm: AudioFile;
  battleback1Name: string;
  battleback2Name: string;
  battlerHue: number;
  battlerName: string;
  boat: Vehicle;
  currencyUnit: string;
  defeatMe: AudioFile;
  editMapId: number;
  elements: string[];
  equipTypes: string[];
  gameTitle: string;
  gameoverMe: AudioFile;
  locale: string;
  magicSkills: number[];
  menuCommands: boolean[];
  optDisplayTp: boolean;
  optDrawTitle: boolean;
  optExtraExp: boolean;
  optFloorDeath: boolean;
  optFollowers: boolean;
  optSideView: boolean;
  optSlipDeath: boolean;
  optTransparent: boolean;
  partyMembers: number[];
  ship: Vehicle;
  skillTypes: string[];
  sounds: AudioFile[];
  startMapId: number;
  startX: number;
  startY: number;
  switches: string[];
  terms: Terms;
  testBattlers: TestBattler[];
  testTroopId: number;
  title1Name: string;
  title2Name: string;
  titleBgm: AudioFile;
  variables: string[];
  versionId: number;
  victoryMe: AudioFile;
  weaponTypes: string[];
  windowTone: number[];
}

export interface Vehicle {
  bgm: AudioFile;
  characterIndex: number;
  characterName: string;
  startMapId: number;
  startX: number;
  startY: number;
}

export interface AttackMotion {
  type: number;
  weaponImageId: number;
}

export interface Terms {
  basic: string[];
  commands: string[];
  params: string[];
  messages: { [key: string]: string };
}

export interface TestBattler {
  actorId: number;
  equips: number[];
  level: number;
}

export interface Tileset {
  id: number;
  name: string;
  mode: number;
  note: string;
  /** The 9 image sheet filenames, positional: [A1,A2,A3,A4,A5,B,C,D,E]; '' = unused. */
  tilesetNames: string[];
  /** One bit-packed flag word per tile id (index === tile id, length 8192). */
  flags: number[];
}

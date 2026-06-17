import type { Vec2 } from './math';

export const playerIds = ['p1', 'p2'] as const;
export type PlayerId = (typeof playerIds)[number];
export type TeamState = 'briefing' | 'playing' | 'won' | 'lost';
export type TextureId = 'bone' | 'rust' | 'meat' | 'door' | 'boss' | 'floor' | 'ceiling';
export type EnemyKind = 'splinterGhoul' | 'rustAcolyte' | 'drumImp';
export type PickupKind = 'medkit' | 'ammo' | 'shells' | 'armor';
export type PropKind = 'barrel' | 'pillar' | 'torch' | 'bones';
export type ProjectileKind = 'enemyBolt' | 'bossBeat';
export type ImpactKind = 'blood' | 'spark' | 'woodBurst' | 'muzzle';

export type WeaponId = 'stakePistol' | 'ribShotgun';
export type AmmoReserveField = 'ammo' | 'shells';

export type WeaponDef = {
  id: WeaponId;
  name: string;
  damage: number;
  range: number;
  falloffStart?: number;
  spread: number;
  cooldown: number;
  fireDuration: number;
  reloadDuration: number;
  magazineSize: number;
  pelletCount: number;
  ammoCost: number;
  reserve: AmmoReserveField;
  sprite: string;
  recoil: number;
  shake: number;
  muzzleDuration: number;
};

export type PlayerState = {
  id: PlayerId;
  name: string;
  pos: Vec2;
  angle: number;
  viewPos: Vec2;
  viewAngle: number;
  bobPhase: number;
  moveBlend: number;
  z: number;
  viewZ: number;
  landingTimer: number;
  spawn: Vec2;
  spawnAngle: number;
  health: number;
  maxHealth: number;
  armor: number;
  ammo: number;
  shells: number;
  magazines: Record<WeaponId, number>;
  weapon: WeaponId;
  cooldown: number;
  fireTimer: number;
  reloadTimer: number;
  reloadDuration: number;
  reloadWeapon: WeaponId | null;
  hurtTimer: number;
  lastHitAngle: number | null;
  dryFireTimer: number;
  faceAngryTimer: number;
  shake: number;
  weaponKick: number;
  muzzleTimer: number;
  deaths: number;
  respawnTimer: number;
  alive: boolean;
};

export type PlayerScore = {
  kills: number;
  damage: number;
  pickups: number;
  deaths: number;
  total: number;
};

export type EnemyState = {
  id: string;
  kind: EnemyKind;
  pos: Vec2;
  radius: number;
  health: number;
  maxHealth: number;
  speed: number;
  facingAngle: number;
  attackRange: number;
  attackCooldown: number;
  cooldown: number;
  painTimer: number;
  deathTimer: number;
  active: boolean;
  waveId?: string;
};

export type BossPhase = 1 | 2 | 3;

export type BossState = {
  id: string;
  pos: Vec2;
  radius: number;
  health: number;
  maxHealth: number;
  phase: BossPhase;
  active: boolean;
  defeated: boolean;
  facingAngle: number;
  cooldown: number;
  beatTimer: number;
  strideTimer: number;
  summonTimer: number;
  painTimer: number;
};

export type PickupState = {
  id: string;
  kind: PickupKind;
  pos: Vec2;
  radius: number;
  amount: number;
  taken: boolean;
};

export type PropState = {
  id: string;
  kind: PropKind;
  pos: Vec2;
  radius: number;
  blocking: boolean;
  health?: number;
  height?: number;
};

export type ProjectileState = {
  id: string;
  kind: ProjectileKind;
  owner: 'enemies' | 'boss';
  pos: Vec2;
  vel: Vec2;
  radius: number;
  damage: number;
  ttl: number;
};

export type ImpactState = {
  id: string;
  kind: ImpactKind;
  pos: Vec2;
  age: number;
  ttl: number;
  scale: number;
  height: number;
  owner?: PlayerId;
};

export type EncounterState = {
  id: string;
  triggered: boolean;
  completed: boolean;
};

export type GameState = {
  mode: TeamState;
  time: number;
  scores: Record<PlayerId, PlayerScore>;
  players: Record<PlayerId, PlayerState>;
  enemies: EnemyState[];
  boss: BossState;
  pickups: PickupState[];
  props: PropState[];
  projectiles: ProjectileState[];
  impacts: ImpactState[];
  encounters: Record<string, EncounterState>;
  objective: string;
  objectiveTimer: number;
  bossGateOpen: boolean;
  victoryTimer: number;
  loseTimer: number;
  nextId: number;
};

export type MissionTile = {
  solid: boolean;
  texture: TextureId;
  hazard?: number;
  height?: number;
};

export type MissionEncounter = {
  id: string;
  label: string;
  zone: { x: number; y: number; w: number; h: number };
  spawns: Array<{ kind: EnemyKind; pos: Vec2 }>;
  objective: string;
};

export type Mission = {
  name: string;
  width: number;
  height: number;
  grid: string[];
  tileLegend: Record<string, MissionTile>;
  playerSpawns: Record<PlayerId, { pos: Vec2; angle: number }>;
  pickups: PickupState[];
  props: PropState[];
  encounters: MissionEncounter[];
  boss: BossState;
  bossArena: { x: number; y: number; w: number; h: number };
  exitZone: { x: number; y: number; w: number; h: number };
};

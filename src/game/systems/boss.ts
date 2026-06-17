import {
  add,
  applyDamage,
  clamp,
  distance,
  normalize,
  rotate,
  scale,
  subtract,
  type DamageRequest,
  type Projectile,
  type Team,
  type Vec2,
} from "./combat";

export type BossPhaseId = "phase1" | "phase2" | "phase3" | "dead";

export type BossAttackKind = "burst" | "radial" | "dash";

export type BossPhaseConfig = {
  id: BossPhaseId;
  startsAtHealthRatio: number;
  speed: number;
  attackCooldownMs: number;
  attackPattern: BossAttackKind;
  projectileDamage: number;
  projectileSpeed: number;
};

export type BossConfig = {
  id: string;
  team?: Team;
  maxHealth: number;
  contactDamage: number;
  phases: readonly BossPhaseConfig[];
};

export type BossState = {
  id: string;
  team: Team;
  position: Vec2;
  facing: Vec2;
  health: number;
  maxHealth: number;
  contactDamage: number;
  phase: BossPhaseId;
  phases: readonly BossPhaseConfig[];
  nextAttackAtMs: number;
  attackSequence: number;
  dashUntilMs?: number;
};

export type BossUpdateContext = {
  playerId: string;
  playerPosition: Vec2;
  nowMs: number;
  deltaMs: number;
  blocked?: (from: Vec2, to: Vec2) => boolean;
};

export type BossAttackEvent = {
  bossId: string;
  targetId: string;
  kind: BossAttackKind;
  contactDamage?: number;
  projectiles: Projectile[];
};

export type BossUpdateResult = {
  boss: BossState;
  attacks: BossAttackEvent[];
};

export function createBoss(config: BossConfig, position: Vec2, nowMs = 0): BossState {
  const phase = resolveBossPhase(config.maxHealth, config.maxHealth, config.phases);

  return {
    id: config.id,
    team: config.team ?? "enemy",
    position,
    facing: { x: 1, y: 0 },
    health: config.maxHealth,
    maxHealth: config.maxHealth,
    contactDamage: config.contactDamage,
    phase,
    phases: config.phases,
    nextAttackAtMs: nowMs,
    attackSequence: 0,
  };
}

export function updateBoss(boss: BossState, context: BossUpdateContext): BossUpdateResult {
  if (boss.health <= 0 || boss.phase === "dead") {
    return {
      boss: {
        ...boss,
        health: 0,
        phase: "dead",
      },
      attacks: [],
    };
  }

  const phase = resolveBossPhase(boss.health, boss.maxHealth, boss.phases);
  const phaseConfig = getPhaseConfig(boss.phases, phase);
  const facing = normalize(subtract(context.playerPosition, boss.position));
  const step = scale(facing, phaseConfig.speed * (Math.max(0, context.deltaMs) / 1000));
  const proposed = add(boss.position, step);
  const canMove = !context.blocked?.(boss.position, proposed);

  let next: BossState = {
    ...boss,
    phase,
    facing,
    position: canMove ? proposed : boss.position,
  };
  const attacks: BossAttackEvent[] = [];

  if (context.nowMs >= boss.nextAttackAtMs) {
    const attack = createBossAttack(next, phaseConfig, context);
    attacks.push(attack);
    next = {
      ...next,
      nextAttackAtMs: context.nowMs + phaseConfig.attackCooldownMs,
      attackSequence: next.attackSequence + 1,
      dashUntilMs:
        phaseConfig.attackPattern === "dash"
          ? context.nowMs + Math.min(450, phaseConfig.attackCooldownMs)
          : undefined,
    };
  }

  if ((next.dashUntilMs ?? 0) > context.nowMs) {
    const dashStep = scale(next.facing, phaseConfig.speed * 2 * (Math.max(0, context.deltaMs) / 1000));
    const dashPosition = add(next.position, dashStep);
    next = {
      ...next,
      position: context.blocked?.(next.position, dashPosition) ? next.position : dashPosition,
    };
  }

  return { boss: next, attacks };
}

export function damageBoss(boss: BossState, request: DamageRequest, nowMs: number): BossState {
  const result = applyDamage(
    {
      health: boss.health,
      maxHealth: boss.maxHealth,
    },
    {
      ...request,
      targetTeam: boss.team,
    },
    nowMs,
  );

  const health = result.health;

  return {
    ...boss,
    health,
    phase: health <= 0 ? "dead" : resolveBossPhase(health, boss.maxHealth, boss.phases),
  };
}

export function resolveBossPhase(
  health: number,
  maxHealth: number,
  phases: readonly BossPhaseConfig[],
): BossPhaseId {
  if (health <= 0) {
    return "dead";
  }

  const ratio = clamp(health / Math.max(1, maxHealth), 0, 1);
  const sorted = [...phases].sort((a, b) => b.startsAtHealthRatio - a.startsAtHealthRatio);

  for (const phase of sorted) {
    if (ratio >= phase.startsAtHealthRatio) {
      return phase.id;
    }
  }

  return sorted[sorted.length - 1]?.id ?? "phase1";
}

function createBossAttack(
  boss: BossState,
  phase: BossPhaseConfig,
  context: BossUpdateContext,
): BossAttackEvent {
  if (phase.attackPattern === "dash") {
    const inContactRange = distance(boss.position, context.playerPosition) <= 0.85;
    return {
      bossId: boss.id,
      targetId: context.playerId,
      kind: "dash",
      contactDamage: inContactRange ? boss.contactDamage : undefined,
      projectiles: [],
    };
  }

  return {
    bossId: boss.id,
    targetId: context.playerId,
    kind: phase.attackPattern,
    projectiles:
      phase.attackPattern === "radial"
        ? createRadialProjectiles(boss, phase, context.nowMs)
        : createBurstProjectiles(boss, phase, context.nowMs),
  };
}

function createBurstProjectiles(
  boss: BossState,
  phase: BossPhaseConfig,
  nowMs: number,
): Projectile[] {
  const spread = [-0.18, 0, 0.18];
  return spread.map((angle, index) =>
    createBossProjectile(boss, phase, nowMs, index, rotate(boss.facing, angle)),
  );
}

function createRadialProjectiles(
  boss: BossState,
  phase: BossPhaseConfig,
  nowMs: number,
): Projectile[] {
  const projectileCount = 10;
  const projectiles: Projectile[] = [];

  for (let index = 0; index < projectileCount; index += 1) {
    const angle = (Math.PI * 2 * index) / projectileCount;
    projectiles.push(createBossProjectile(boss, phase, nowMs, index, rotate({ x: 1, y: 0 }, angle)));
  }

  return projectiles;
}

function createBossProjectile(
  boss: BossState,
  phase: BossPhaseConfig,
  nowMs: number,
  index: number,
  direction: Vec2,
): Projectile {
  return {
    id: `boss-${boss.id}-${phase.id}-${boss.attackSequence}-${nowMs}-${index}`,
    ownerId: boss.id,
    team: boss.team,
    position: { ...boss.position },
    velocity: scale(normalize(direction), phase.projectileSpeed),
    damage: phase.projectileDamage,
    radius: 0.18,
    ageMs: 0,
    maxAgeMs: 3500,
    pierceRemaining: 0,
  };
}

function getPhaseConfig(
  phases: readonly BossPhaseConfig[],
  phase: BossPhaseId,
): BossPhaseConfig {
  const phaseConfig = phases.find((candidate) => candidate.id === phase);
  if (phaseConfig) {
    return phaseConfig;
  }

  const fallback = phases[0];
  if (!fallback) {
    throw new Error("Boss requires at least one active phase.");
  }

  return fallback;
}

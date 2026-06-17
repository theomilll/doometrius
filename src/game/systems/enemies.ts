import {
  add,
  applyDamage,
  clamp,
  distance,
  normalize,
  scale,
  subtract,
  type DamageRequest,
  type Projectile,
  type Team,
  type Vec2,
} from "./combat";

export type EnemyKind = "grunt" | "shooter" | "brute";

export type EnemyIntent = "idle" | "chase" | "attack" | "dead";

export type EnemyConfig = {
  kind: EnemyKind;
  maxHealth: number;
  speed: number;
  sightRange: number;
  attackRange: number;
  attackCooldownMs: number;
  contactDamage: number;
  projectileSpeed?: number;
  projectileDamage?: number;
  deathDropTable?: readonly DeathDropEntry[];
};

export type DeathDropEntry = {
  id: string;
  weight: number;
};

export type EnemyState = {
  id: string;
  kind: EnemyKind;
  team: Team;
  position: Vec2;
  facing: Vec2;
  health: number;
  maxHealth: number;
  speed: number;
  sightRange: number;
  attackRange: number;
  attackCooldownMs: number;
  nextAttackAtMs: number;
  contactDamage: number;
  projectileSpeed?: number;
  projectileDamage?: number;
  deathDropTable: readonly DeathDropEntry[];
  intent: EnemyIntent;
  deadAtMs?: number;
};

export type EnemyUpdateContext = {
  playerId: string;
  playerPosition: Vec2;
  nowMs: number;
  deltaMs: number;
  blocked?: (from: Vec2, to: Vec2) => boolean;
};

export type EnemyAttackEvent = {
  enemyId: string;
  targetId: string;
  damage: number;
  projectile?: Projectile;
};

export type EnemyDeathDrop = {
  enemyId: string;
  itemId: string;
  position: Vec2;
};

export type EnemyUpdateResult = {
  enemies: EnemyState[];
  attacks: EnemyAttackEvent[];
  drops: EnemyDeathDrop[];
};

export function createEnemy(id: string, config: EnemyConfig, position: Vec2, nowMs = 0): EnemyState {
  return {
    id,
    kind: config.kind,
    team: "enemy",
    position,
    facing: { x: 1, y: 0 },
    health: config.maxHealth,
    maxHealth: config.maxHealth,
    speed: config.speed,
    sightRange: config.sightRange,
    attackRange: config.attackRange,
    attackCooldownMs: config.attackCooldownMs,
    nextAttackAtMs: nowMs,
    contactDamage: config.contactDamage,
    projectileSpeed: config.projectileSpeed,
    projectileDamage: config.projectileDamage,
    deathDropTable: config.deathDropTable ?? [],
    intent: "idle",
  };
}

export function updateEnemies(
  enemies: readonly EnemyState[],
  context: EnemyUpdateContext,
): EnemyUpdateResult {
  const nextEnemies: EnemyState[] = [];
  const attacks: EnemyAttackEvent[] = [];
  const drops: EnemyDeathDrop[] = [];

  for (const enemy of enemies) {
    if (enemy.intent === "dead" || enemy.health <= 0) {
      const deadEnemy = markDead(enemy, context.nowMs);
      const drop = chooseDeathDrop(deadEnemy);
      if (drop) {
        drops.push({
          enemyId: deadEnemy.id,
          itemId: drop,
          position: deadEnemy.position,
        });
      }
      continue;
    }

    const toPlayer = subtract(context.playerPosition, enemy.position);
    const playerDistance = distance(enemy.position, context.playerPosition);
    const facing = normalize(toPlayer);
    const canSeePlayer = playerDistance <= enemy.sightRange;
    const canAttack = playerDistance <= enemy.attackRange;

    let next = {
      ...enemy,
      facing,
      intent: canSeePlayer ? ("chase" as EnemyIntent) : ("idle" as EnemyIntent),
    };

    if (canSeePlayer && !canAttack) {
      const step = scale(facing, enemy.speed * (Math.max(0, context.deltaMs) / 1000));
      const proposed = add(enemy.position, step);
      next = {
        ...next,
        position: context.blocked?.(enemy.position, proposed) ? enemy.position : proposed,
      };
    }

    if (canAttack && context.nowMs >= enemy.nextAttackAtMs) {
      next = {
        ...next,
        intent: "attack",
        nextAttackAtMs: context.nowMs + Math.max(0, enemy.attackCooldownMs),
      };
      attacks.push(createEnemyAttack(next, context.playerId, context.nowMs));
    }

    nextEnemies.push(next);
  }

  return { enemies: nextEnemies, attacks, drops };
}

export function damageEnemy(enemy: EnemyState, request: DamageRequest, nowMs: number): EnemyState {
  const result = applyDamage(
    {
      health: enemy.health,
      maxHealth: enemy.maxHealth,
    },
    {
      ...request,
      targetTeam: enemy.team,
    },
    nowMs,
  );

  if (result.killed) {
    return markDead({ ...enemy, health: result.health }, nowMs);
  }

  return {
    ...enemy,
    health: result.health,
  };
}

export function chooseDeathDrop(enemy: EnemyState): string | null {
  const entries = enemy.deathDropTable.filter((entry) => entry.weight > 0);
  const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);
  if (totalWeight <= 0) {
    return null;
  }

  const seed = stableHash(enemy.id) % totalWeight;
  let cursor = 0;

  for (const entry of entries) {
    cursor += entry.weight;
    if (seed < cursor) {
      return entry.id;
    }
  }

  return entries[entries.length - 1]?.id ?? null;
}

function createEnemyAttack(enemy: EnemyState, targetId: string, nowMs: number): EnemyAttackEvent {
  if (enemy.projectileSpeed && enemy.projectileDamage) {
    return {
      enemyId: enemy.id,
      targetId,
      damage: enemy.projectileDamage,
      projectile: {
        id: `enemy-${enemy.id}-${nowMs}`,
        ownerId: enemy.id,
        team: enemy.team,
        position: { ...enemy.position },
        velocity: scale(normalize(enemy.facing), enemy.projectileSpeed),
        damage: enemy.projectileDamage,
        radius: 0.12,
        ageMs: 0,
        maxAgeMs: 2500,
        pierceRemaining: 0,
      },
    };
  }

  return {
    enemyId: enemy.id,
    targetId,
    damage: enemy.contactDamage,
  };
}

function markDead(enemy: EnemyState, nowMs: number): EnemyState {
  return {
    ...enemy,
    health: clamp(enemy.health, 0, enemy.maxHealth),
    intent: "dead",
    deadAtMs: enemy.deadAtMs ?? nowMs,
  };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

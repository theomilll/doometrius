export type Vec2 = {
  x: number;
  y: number;
};

export type Team = "player" | "enemy" | "neutral";

export type DamageKind = "bullet" | "melee" | "explosion" | "hazard";

export type DamageRequest = {
  amount: number;
  kind: DamageKind;
  sourceId: string;
  sourceTeam: Team;
  targetTeam: Team;
  armorPierce?: number;
  criticalMultiplier?: number;
};

export type DamageResult = {
  applied: number;
  health: number;
  killed: boolean;
};

export type HealthState = {
  health: number;
  maxHealth: number;
  armor?: number;
  invulnerableUntil?: number;
};

export type Projectile = {
  id: string;
  ownerId: string;
  team: Team;
  position: Vec2;
  velocity: Vec2;
  damage: number;
  radius: number;
  ageMs: number;
  maxAgeMs: number;
  pierceRemaining: number;
};

export type ProjectileSpawn = Omit<Projectile, "ageMs">;

export type ProjectileUpdateResult = {
  active: Projectile[];
  expired: Projectile[];
};

export type WeaponConfig = {
  id: string;
  ownerId: string;
  team: Team;
  projectileSpeed: number;
  projectileRadius: number;
  projectileDamage: number;
  projectileLifetimeMs: number;
  pellets: number;
  spreadRadians: number;
  pierce: number;
  cooldownMs: number;
};

export type WeaponState = {
  nextFireAtMs: number;
  shotSequence: number;
};

export type FireWeaponInput = {
  config: WeaponConfig;
  state: WeaponState;
  nowMs: number;
  origin: Vec2;
  direction: Vec2;
};

export type FireWeaponResult = {
  state: WeaponState;
  projectiles: Projectile[];
  fired: boolean;
};

export function createWeaponState(readyAtMs = 0): WeaponState {
  return {
    nextFireAtMs: readyAtMs,
    shotSequence: 0,
  };
}

export function fireWeapon(input: FireWeaponInput): FireWeaponResult {
  const { config, state, nowMs, origin } = input;

  if (nowMs < state.nextFireAtMs) {
    return { state, projectiles: [], fired: false };
  }

  const direction = normalize(input.direction);
  const pellets = Math.max(1, Math.floor(config.pellets));
  const projectiles: Projectile[] = [];

  for (let index = 0; index < pellets; index += 1) {
    const offset =
      pellets === 1
        ? 0
        : lerp(-config.spreadRadians / 2, config.spreadRadians / 2, index / (pellets - 1));
    const shotDirection = rotate(direction, offset);
    const sequence = state.shotSequence + index;

    projectiles.push({
      id: `${config.id}-${config.ownerId}-${nowMs}-${sequence}`,
      ownerId: config.ownerId,
      team: config.team,
      position: { ...origin },
      velocity: scale(shotDirection, config.projectileSpeed),
      damage: config.projectileDamage,
      radius: config.projectileRadius,
      ageMs: 0,
      maxAgeMs: config.projectileLifetimeMs,
      pierceRemaining: Math.max(0, Math.floor(config.pierce)),
    });
  }

  return {
    state: {
      nextFireAtMs: nowMs + Math.max(0, config.cooldownMs),
      shotSequence: state.shotSequence + pellets,
    },
    projectiles,
    fired: true,
  };
}

export function applyDamage(target: HealthState, request: DamageRequest, nowMs: number): DamageResult {
  if (target.health <= 0 || (target.invulnerableUntil ?? -1) > nowMs) {
    return {
      applied: 0,
      health: clamp(target.health, 0, target.maxHealth),
      killed: target.health <= 0,
    };
  }

  if (request.sourceTeam === request.targetTeam && request.sourceTeam !== "neutral") {
    return {
      applied: 0,
      health: clamp(target.health, 0, target.maxHealth),
      killed: false,
    };
  }

  const armor = Math.max(0, (target.armor ?? 0) - (request.armorPierce ?? 0));
  const multiplier = Math.max(0, request.criticalMultiplier ?? 1);
  const rawDamage = Math.max(0, request.amount) * multiplier;
  const applied = Math.max(0, rawDamage - armor);
  const nextHealth = clamp(target.health - applied, 0, target.maxHealth);

  return {
    applied,
    health: nextHealth,
    killed: nextHealth <= 0 && target.health > 0,
  };
}

export function updateProjectiles(
  projectiles: readonly Projectile[],
  deltaMs: number,
): ProjectileUpdateResult {
  const active: Projectile[] = [];
  const expired: Projectile[] = [];
  const stepSeconds = Math.max(0, deltaMs) / 1000;

  for (const projectile of projectiles) {
    const next: Projectile = {
      ...projectile,
      position: add(projectile.position, scale(projectile.velocity, stepSeconds)),
      ageMs: projectile.ageMs + Math.max(0, deltaMs),
    };

    if (next.ageMs >= next.maxAgeMs) {
      expired.push(next);
    } else {
      active.push(next);
    }
  }

  return { active, expired };
}

export function consumeProjectilePierce(projectile: Projectile): Projectile | null {
  if (projectile.pierceRemaining <= 0) {
    return null;
  }

  return {
    ...projectile,
    pierceRemaining: projectile.pierceRemaining - 1,
  };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(vector: Vec2, value: number): Vec2 {
  return { x: vector.x * value, y: vector.y * value };
}

export function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return length(subtract(a, b));
}

export function normalize(vector: Vec2): Vec2 {
  const magnitude = length(vector);
  if (magnitude === 0) {
    return { x: 1, y: 0 };
  }

  return { x: vector.x / magnitude, y: vector.y / magnitude };
}

export function rotate(vector: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

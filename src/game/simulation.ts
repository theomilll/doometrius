import { angleTo, clamp, distance, lerp, normalizeAngle, pointInCircle, type Vec2 } from './core/math';
import { createGameState, nextEntityId } from './core/state';
import { playerIds } from './core/types';
import type {
  BossPhase,
  EnemyKind,
  EnemyState,
  GameState,
  ImpactKind,
  Mission,
  PickupKind,
  PlayerId,
  PlayerState,
  ProjectileState,
  WeaponId,
} from './core/types';
import { getTile, hasLineOfSight, moveWithCollision, rectContains } from './core/world';
import type { PlayerInput } from './input';
import { weapons } from './weapons';

export type Inputs = Record<PlayerId, PlayerInput>;

export type SimulationOptions = {
  connectedPlayers?: readonly PlayerId[];
};

export function createNeutralInput(): PlayerInput {
  return {
    forward: 0,
    strafe: 0,
    turn: 0,
    look: 0,
    shoot: false,
    reload: false,
    sprint: false,
    weapon: null,
    restart: false,
  };
}

const playerRadius = 0.18;
const playerWalkSpeed = 2.38;
const playerSprintSpeed = 3.12;
const playerTurnSpeed = 2.85;
const pickupReach = 0.46;
const maxMoveStep = 0.09;

export type HitscanHit =
  | { kind: 'enemy'; target: EnemyState; point: Vec2; dist: number }
  | { kind: 'boss'; point: Vec2; dist: number }
  | { kind: 'prop'; target: NonNullable<GameState['props'][number]>; point: Vec2; dist: number }
  | { kind: 'wall'; point: Vec2; dist: number };

const enemyDefs: Record<EnemyKind, Omit<EnemyState, 'id' | 'pos' | 'facingAngle' | 'cooldown' | 'painTimer' | 'deathTimer' | 'active' | 'waveId'>> = {
  splinterGhoul: {
    kind: 'splinterGhoul',
    radius: 0.28,
    health: 70,
    maxHealth: 70,
    speed: 1.42,
    attackRange: 0.72,
    attackCooldown: 0.92,
  },
  rustAcolyte: {
    kind: 'rustAcolyte',
    radius: 0.3,
    health: 92,
    maxHealth: 92,
    speed: 0.92,
    attackRange: 5.2,
    attackCooldown: 1.55,
  },
  drumImp: {
    kind: 'drumImp',
    radius: 0.24,
    health: 48,
    maxHealth: 48,
    speed: 1.9,
    attackRange: 0.62,
    attackCooldown: 0.72,
  },
};

export function updateGame(state: GameState, mission: Mission, inputs: Inputs, dt: number, options: SimulationOptions = {}) {
  const safeDt = clamp(dt, 0, 0.05);
  const connectedPlayers = resolveConnectedPlayers(options.connectedPlayers);
  const coopScale = connectedPlayers.length >= 2 ? 1.35 : 1;
  state.time += safeDt;

  if (state.mode === 'briefing') {
    if (playerIds.some((id) => {
      const input = inputs[id];
      return input && (input.shoot || input.restart);
    })) {
      state.mode = 'playing';
      state.objective = 'Clear each room, collect supplies, and find the boss arena.';
      triggerEncounter(state, mission, 'initial-entry', coopScale);
    }
    return;
  }

  if (state.mode === 'won' || state.mode === 'lost') {
    if (playerIds.some((id) => inputs[id]?.restart)) {
      const fresh = createGameState(mission);
      Object.assign(state, fresh);
    }
    return;
  }

  for (const id of playerIds) {
    updatePlayer(state, mission, state.players[id], inputs[id] ?? createNeutralInput(), safeDt);
  }

  updatePickups(state);
  updateEncounters(state, mission, coopScale);
  updateEnemies(state, mission, safeDt, connectedPlayers);
  updateBoss(state, mission, safeDt, connectedPlayers, coopScale);
  updateProjectiles(state, mission, safeDt);
  updateImpacts(state, safeDt);
  updateMissionOutcome(state, mission, connectedPlayers);
}

function resolveConnectedPlayers(connectedPlayers?: readonly PlayerId[]) {
  const valid = connectedPlayers?.filter((id): id is PlayerId => playerIds.includes(id)) ?? playerIds;
  return valid.length ? valid : playerIds;
}

function updatePlayer(state: GameState, mission: Mission, player: PlayerState, input: PlayerInput, dt: number) {
  player.cooldown = Math.max(0, player.cooldown - dt);
  player.fireTimer = Math.max(0, player.fireTimer - dt);
  player.hurtTimer = Math.max(0, player.hurtTimer - dt);
  player.dryFireTimer = Math.max(0, player.dryFireTimer - dt);
  player.faceAngryTimer = Math.max(0, player.faceAngryTimer - dt);
  player.shake = Math.max(0, player.shake - dt * 10);
  player.weaponKick = Math.max(0, player.weaponKick - dt * 8);
  player.muzzleTimer = Math.max(0, player.muzzleTimer - dt);
  player.landingTimer = Math.max(0, player.landingTimer - dt);
  updateReload(player, dt);

  if (!player.alive) {
    player.respawnTimer = Math.max(0, player.respawnTimer - dt);
    if (player.respawnTimer <= 0 && player.deaths < 3) {
      player.alive = true;
      player.health = Math.max(60, player.maxHealth * 0.6);
      player.armor = 0;
      player.pos = { ...player.spawn };
      player.angle = player.spawnAngle;
      player.viewPos = { ...player.spawn };
      player.viewAngle = player.spawnAngle;
      player.bobPhase = 0;
      player.moveBlend = 0;
      player.z = 0;
      player.viewZ = 0;
      player.landingTimer = 0;
      player.fireTimer = 0;
      player.reloadTimer = 0;
      player.reloadDuration = 0;
      player.reloadWeapon = null;
      player.faceAngryTimer = 0;
      player.lastHitAngle = null;
      player.dryFireTimer = 0;
    }
    return;
  }

  const moved = applyPlayerMovement(mission, state.props, { pos: player.pos, angle: player.angle }, input, dt);
  player.angle = moved.angle;
  player.pos = moved.pos;
  const inputMagnitude = Math.hypot(input.forward, input.strafe);
  smoothPlayerCamera(player, inputMagnitude > 0, input.sprint, dt);

  const tile = getTile(mission, player.pos.x, player.pos.y);
  if (tile.hazard) {
    damagePlayer(state, player, tile.hazard * dt, 0.05, null);
  }

  if (input.weapon && input.weapon !== player.weapon && !player.reloadWeapon) {
    player.weapon = input.weapon;
    player.cooldown = Math.max(player.cooldown, 0.25);
    player.weaponKick = Math.max(player.weaponKick, 0.5);
    player.fireTimer = 0;
    player.muzzleTimer = 0;
  }
  if (input.reload) {
    startReload(player, player.weapon);
  }
  if (input.shoot) {
    tryShoot(state, mission, player);
  }
}

export type MoveState = { pos: Vec2; angle: number };

// Pure movement core shared by server simulation and client-side prediction.
// Must stay deterministic for a given (state, input, dt) on both sides.
export function applyPlayerMovement(
  mission: Mission,
  props: GameState['props'],
  current: MoveState,
  input: PlayerInput,
  dt: number,
): MoveState {
  const angle = normalizeAngle(current.angle + input.turn * dt * playerTurnSpeed + input.look);
  const speed = input.sprint ? playerSprintSpeed : playerWalkSpeed;
  const forward = { x: Math.cos(angle), y: Math.sin(angle) };
  const right = { x: -Math.sin(angle), y: Math.cos(angle) };
  const inputMagnitude = Math.hypot(input.forward, input.strafe);
  const inputScale = inputMagnitude > 1 ? 1 / inputMagnitude : 1;
  const delta = {
    x: (forward.x * input.forward + right.x * input.strafe) * inputScale * speed * dt,
    y: (forward.y * input.forward + right.y * input.strafe) * inputScale * speed * dt,
  };
  if (!delta.x && !delta.y) return { pos: current.pos, angle };
  return { pos: moveActor(mission, props, current.pos, delta, playerRadius, 0), angle };
}

export type CameraState = Pick<PlayerState, 'pos' | 'angle' | 'z' | 'viewPos' | 'viewAngle' | 'viewZ' | 'moveBlend' | 'bobPhase'>;

export function smoothPlayerCamera(player: CameraState, moving: boolean, sprinting: boolean, dt: number) {
  const cameraT = 1 - Math.exp(-dt * 18);
  const angleT = 1 - Math.exp(-dt * 22);
  player.viewPos = {
    x: lerp(player.viewPos.x, player.pos.x, cameraT),
    y: lerp(player.viewPos.y, player.pos.y, cameraT),
  };
  player.viewAngle = normalizeAngle(player.viewAngle + normalizeAngle(player.angle - player.viewAngle) * angleT);
  player.viewZ = lerp(player.viewZ, player.z, 1 - Math.exp(-dt * 20));
  const targetBlend = moving ? 1 : 0;
  player.moveBlend = lerp(player.moveBlend, targetBlend, 1 - Math.exp(-dt * 9));
  player.bobPhase += dt * (sprinting ? 12.5 : 9.2) * player.moveBlend;
}

function updateReload(player: PlayerState, dt: number) {
  if (!player.reloadWeapon || player.reloadTimer <= 0) return;
  player.reloadTimer = Math.max(0, player.reloadTimer - dt);
  if (player.reloadTimer > 0) return;

  const weaponId = player.reloadWeapon;
  const weapon = weapons[weaponId];
  const reserveField = weapon.reserve;
  const needed = weapon.magazineSize - player.magazines[weaponId];
  const loaded = Math.min(Math.max(0, needed), Math.max(0, player[reserveField]));
  player.magazines[weaponId] += loaded;
  player[reserveField] -= loaded;
  player.reloadWeapon = null;
  player.reloadDuration = 0;
  player.cooldown = Math.min(player.cooldown, 0.05);
}

function startReload(player: PlayerState, weaponId: WeaponId) {
  if (!player.alive || player.reloadWeapon) return false;
  const weapon = weapons[weaponId];
  if (player.magazines[weaponId] >= weapon.magazineSize) return false;
  if (player[weapon.reserve] <= 0) return false;
  player.reloadWeapon = weaponId;
  player.reloadDuration = weapon.reloadDuration;
  player.reloadTimer = weapon.reloadDuration;
  player.cooldown = Math.max(player.cooldown, weapon.reloadDuration);
  player.fireTimer = 0;
  player.muzzleTimer = 0;
  player.weaponKick = Math.max(player.weaponKick, 0.28);
  return true;
}

function tryShoot(state: GameState, mission: Mission, player: PlayerState) {
  selectUsableWeapon(player);
  const weapon = weapons[player.weapon];
  if (player.reloadWeapon || player.cooldown > 0 || !player.alive) return;
  if (player.magazines[player.weapon] < weapon.ammoCost) {
    if (startReload(player, player.weapon)) return;
    player.cooldown = 0.22;
    player.weaponKick = 0.45;
    player.dryFireTimer = 0.2;
    return;
  }

  player.magazines[player.weapon] -= weapon.ammoCost;
  player.cooldown = weapon.cooldown;
  player.fireTimer = weapon.fireDuration;
  player.weaponKick = weapon.recoil;
  player.muzzleTimer = weapon.muzzleDuration;
  player.faceAngryTimer = Math.max(player.faceAngryTimer, 0.42);
  player.shake = weapon.shake;
  addImpact(state, 'muzzle', {
    x: player.pos.x + Math.cos(player.angle) * 0.5,
    y: player.pos.y + Math.sin(player.angle) * 0.5,
  }, 0.35, 0.42, player.id);

  for (let pellet = 0; pellet < weapon.pelletCount; pellet += 1) {
    const spreadIndex = weapon.pelletCount === 1 ? 0 : pellet / (weapon.pelletCount - 1) - 0.5;
    const shotAngle = player.angle + spreadIndex * weapon.spread + Math.sin(state.time * 31 + pellet) * weapon.spread * 0.15;
    const hit = findHitscanTarget(state, mission, player.pos, shotAngle, weapon.range);
    if (hit) {
      const damage = weaponDamageAt(weapon, hit.dist);
      if (hit.kind === 'enemy') {
        damageEnemyState(state, player.id, hit.target, damage, shotAngle, hit.point);
      } else if (hit.kind === 'boss') {
        damageBossState(state, player.id, damage, shotAngle, hit.point);
      } else if (hit.kind === 'prop') {
        hit.target.health = Math.max(0, (hit.target.health ?? 1) - damage);
        addImpact(state, 'spark', hit.point, 0.6, 0.35);
        if (hit.target.health <= 0) {
          hit.target.blocking = false;
          addImpact(state, 'woodBurst', hit.target.pos, 1, 0.3);
        }
      } else {
        addImpact(state, 'spark', hit.point, 0.45, 0.45);
      }
    }
  }
}

function weaponDamageAt(weapon: (typeof weapons)[WeaponId], dist: number) {
  if (!weapon.falloffStart || dist <= weapon.falloffStart) return weapon.damage;
  const ratio = clamp((dist - weapon.falloffStart) / (weapon.range - weapon.falloffStart), 0, 1);
  return weapon.damage * lerp(1, 0.6, ratio);
}

function selectUsableWeapon(player: PlayerState) {
  if (player.reloadWeapon) return;
  const current = weapons[player.weapon];
  if (player.magazines[player.weapon] > 0 || player[current.reserve] > 0) return;
  if (player.weapon === 'ribShotgun' && (player.magazines.stakePistol > 0 || player.ammo > 0)) {
    player.weapon = 'stakePistol';
  } else if (player.weapon === 'stakePistol' && (player.magazines.ribShotgun > 0 || player.shells > 0)) {
    player.weapon = 'ribShotgun';
  }
}

export function findHitscanTarget(state: GameState, mission: Mission, origin: Vec2, angle: number, range: number): HitscanHit | null {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const samples = Math.ceil(range / 0.06);
  for (let i = 1; i <= samples; i += 1) {
    const distAt = (i / samples) * range;
    const point = { x: origin.x + dir.x * distAt, y: origin.y + dir.y * distAt };
    if (getTile(mission, point.x, point.y).solid) return { kind: 'wall', point, dist: distAt };
    for (const prop of state.props) {
      if (!prop.blocking || prop.health === 0) continue;
      if (pointInCircle(point, prop.pos, prop.radius)) return { kind: 'prop' as const, target: prop, point, dist: distAt };
    }
    for (const enemy of state.enemies) {
      if (!enemy.active || enemy.health <= 0) continue;
      if (pointInCircle(point, enemy.pos, enemy.radius)) return { kind: 'enemy' as const, target: enemy, point, dist: distAt };
    }
    if (state.boss.active && !state.boss.defeated && pointInCircle(point, state.boss.pos, state.boss.radius)) {
      return { kind: 'boss', point, dist: distAt };
    }
  }
  return null;
}

function updatePickups(state: GameState) {
  for (const pickup of state.pickups) {
    if (pickup.taken) continue;
    for (const id of playerIds) {
      const player = state.players[id];
      if (!player.alive || !pointInCircle(player.pos, pickup.pos, pickup.radius + pickupReach)) continue;
      applyPickup(player, pickup.kind, pickup.amount);
      recordPickup(state, id);
      pickup.taken = true;
      state.objective = pickup.kind === 'medkit' ? 'Health restored. Keep moving.' : 'Supplies acquired.';
      state.objectiveTimer = 2.2;
    }
  }
}

function applyPickup(player: PlayerState, kind: PickupKind, amount: number) {
  if (kind === 'medkit') player.health = clamp(player.health + amount, 1, player.maxHealth);
  if (kind === 'armor') player.armor = clamp(player.armor + amount, 0, 80);
  if (kind === 'ammo') player.ammo = clamp(player.ammo + amount, 0, 180);
  if (kind === 'shells') {
    player.shells = clamp(player.shells + amount, 0, 64);
  }
}

function updateEncounters(state: GameState, mission: Mission, coopScale: number) {
  for (const encounter of mission.encounters) {
    const saved = state.encounters[encounter.id];
    if (!saved || saved.triggered) continue;
    if (playerIds.some((id) => state.players[id].alive && rectContains(encounter.zone, state.players[id].pos))) {
      triggerEncounter(state, mission, encounter.id, coopScale);
    }
  }
}

function triggerEncounter(state: GameState, mission: Mission, encounterId: string, coopScale: number) {
  const encounter = mission.encounters.find((item) => item.id === encounterId);
  const saved = state.encounters[encounterId];
  if (!encounter || !saved || saved.triggered) return;
  saved.triggered = true;
  state.objective = encounter.objective;
  state.objectiveTimer = 4;
  if (encounter.id === 'trigger.boss-entry') {
    state.boss.active = true;
    if (coopScale > 1) {
      const bossScale = 1.3;
      state.boss.health = Math.round(state.boss.health * bossScale);
      state.boss.maxHealth = Math.round(state.boss.maxHealth * bossScale);
    }
    state.objective = 'Boss arena locked. Break the Sahurwood rhythm.';
    return;
  }
  for (const spawn of encounter.spawns) {
    state.enemies.push(createEnemy(state, spawn.kind, spawn.pos, encounter.id, coopScale));
  }
}

function createEnemy(state: GameState, kind: EnemyKind, pos: Vec2, waveId?: string, healthScale = 1): EnemyState {
  const def = enemyDefs[kind];
  const maxHealth = Math.round(def.maxHealth * healthScale);
  return {
    id: nextEntityId(state, kind),
    kind,
    pos: { ...pos },
    radius: def.radius,
    health: maxHealth,
    maxHealth,
    speed: def.speed,
    facingAngle: 0,
    attackRange: def.attackRange,
    attackCooldown: def.attackCooldown,
    cooldown: 0.4,
    painTimer: 0,
    deathTimer: 0,
    active: true,
    waveId,
  };
}

function updateEnemies(state: GameState, mission: Mission, dt: number, connectedPlayers: readonly PlayerId[]) {
  for (const enemy of state.enemies) {
    enemy.cooldown = Math.max(0, enemy.cooldown - dt);
    enemy.painTimer = Math.max(0, enemy.painTimer - dt);
    if (!enemy.active || enemy.health <= 0) {
      enemy.deathTimer += dt;
      continue;
    }

    const target = nearestAlivePlayer(state, enemy.pos, connectedPlayers);
    if (!target) continue;
    const dist = distance(enemy.pos, target.pos);
    const los = hasLineOfSight(mission, state.props, enemy.pos, target.pos);
    const angle = angleTo(enemy.pos, target.pos);
    enemy.facingAngle = turnToward(enemy.facingAngle, angle, dt * enemyTurnSpeed(enemy.kind));

    // Hitstun: getting shot interrupts the advance, so weapons can hold a charge back.
    if (enemy.kind !== 'rustAcolyte' && dist > enemy.attackRange * 0.88 && enemy.painTimer <= 0) {
      const next = moveWithCollision(
        mission,
        state.props,
        enemy.pos,
        { x: Math.cos(angle) * enemy.speed * 0.92 * dt, y: Math.sin(angle) * enemy.speed * 0.92 * dt },
        enemy.radius,
      );
      enemy.pos = next;
    }

    if (enemy.cooldown <= 0 && los && dist <= enemy.attackRange) {
      if (enemy.kind === 'rustAcolyte') {
        addProjectile(state, 'enemyBolt', 'enemies', enemy.pos, angle, 4.35, 10, 2.4);
      } else {
        damagePlayer(state, target, enemy.kind === 'drumImp' ? 8 : 13, 0.28, enemy.pos);
      }
      enemy.cooldown = enemy.attackCooldown;
    }

    if (enemy.kind === 'rustAcolyte' && dist > 3 && los && enemy.painTimer <= 0) {
      const strafe = Math.sin(state.time * 1.7 + enemy.id.length) > 0 ? 1 : -1;
      enemy.pos = moveWithCollision(
        mission,
        state.props,
        enemy.pos,
        { x: Math.cos(angle + Math.PI / 2) * strafe * enemy.speed * 0.35 * dt, y: Math.sin(angle + Math.PI / 2) * strafe * enemy.speed * 0.35 * dt },
        enemy.radius,
      );
    }
  }

  state.enemies = state.enemies.filter((enemy) => enemy.health > 0 || enemy.deathTimer < 0.8);

  for (const encounter of mission.encounters) {
    const saved = state.encounters[encounter.id];
    if (!saved || !saved.triggered || saved.completed) continue;
    const remaining = state.enemies.some((enemy) => enemy.active && enemy.waveId === encounter.id && enemy.health > 0);
    if (!remaining) saved.completed = true;
  }
}

function updateBoss(state: GameState, mission: Mission, dt: number, connectedPlayers: readonly PlayerId[], coopScale: number) {
  const boss = state.boss;
  if (!boss.active || boss.defeated) return;
  boss.cooldown = Math.max(0, boss.cooldown - dt);
  boss.beatTimer = Math.max(0, boss.beatTimer - dt);
  boss.strideTimer += dt;
  boss.summonTimer -= dt;
  boss.painTimer = Math.max(0, boss.painTimer - dt);

  const phase = resolveBossPhase(boss.health / boss.maxHealth);
  if (phase !== boss.phase) {
    boss.phase = phase;
    state.objective = phase === 2 ? 'The wooden nightmare changes tempo. Use the pillars.' : 'Final rhythm. Keep distance from the blood floor.';
    state.objectiveTimer = 3.5;
    spawnBossAdds(state, phase, coopScale);
    addImpact(state, 'woodBurst', boss.pos, 1.4);
  }

  const target = nearestAlivePlayer(state, boss.pos, connectedPlayers);
  if (!target) return;
  const angle = angleTo(boss.pos, target.pos);
  const dist = distance(boss.pos, target.pos);
  boss.facingAngle = turnToward(boss.facingAngle, angle, dt * (phase === 3 ? 3.8 : 3.1));
  const speed = phase === 1 ? 0.65 : phase === 2 ? 0.92 : 1.18;
  if (dist > 1.35) {
    boss.pos = moveWithCollision(
      mission,
      state.props,
      boss.pos,
      { x: Math.cos(angle) * speed * dt, y: Math.sin(angle) * speed * dt },
      boss.radius,
    );
  }
  if (dist < 0.92 && boss.cooldown <= 0) {
    damagePlayer(state, target, phase === 3 ? 23 : 17, 0.48, boss.pos);
    boss.cooldown = 1.05;
    boss.beatTimer = 0.22;
  }
  if (boss.cooldown <= 0) {
    if (phase === 1) {
      addProjectile(state, 'bossBeat', 'boss', boss.pos, angle, 3.9, 15, 3.4);
    } else if (phase === 2) {
      [-0.22, 0, 0.22].forEach((offset) => addProjectile(state, 'bossBeat', 'boss', boss.pos, angle + offset, 4.35, 15, 3));
    } else {
      for (let i = 0; i < 10; i += 1) addProjectile(state, 'bossBeat', 'boss', boss.pos, (Math.PI * 2 * i) / 10 + state.time * 0.4, 3.15, 14, 3.5);
    }
    boss.cooldown = phase === 1 ? 1.5 : phase === 2 ? 1.2 : 1.0;
    boss.beatTimer = 0.2;
  }
  if (boss.summonTimer <= 0) {
    spawnBossAdds(state, boss.phase, coopScale);
    boss.summonTimer = boss.phase === 3 ? 8 : 11;
  }
}

function resolveBossPhase(ratio: number): BossPhase {
  if (ratio <= 0.3) return 3;
  if (ratio <= 0.65) return 2;
  return 1;
}

function enemyTurnSpeed(kind: EnemyKind) {
  if (kind === 'drumImp') return 7.4;
  if (kind === 'rustAcolyte') return 3.9;
  return 5.8;
}

function turnToward(current: number, target: number, maxStep: number) {
  const delta = normalizeAngle(target - current);
  const step = clamp(delta, -maxStep, maxStep);
  return normalizeAngle(current + step);
}

function spawnBossAdds(state: GameState, phase: BossPhase, coopScale: number) {
  const boss = state.boss.pos;
  const spawns = phase === 2
    ? [
        { kind: 'drumImp' as EnemyKind, pos: { x: boss.x - 3, y: boss.y + 1 } },
        { kind: 'splinterGhoul' as EnemyKind, pos: { x: boss.x + 3, y: boss.y + 1 } },
      ]
    : [
        { kind: 'drumImp' as EnemyKind, pos: { x: boss.x - 3, y: boss.y - 1 } },
        { kind: 'rustAcolyte' as EnemyKind, pos: { x: boss.x + 3, y: boss.y - 1 } },
      ];
  for (const spawn of spawns) {
    addImpact(state, 'woodBurst', spawn.pos, 0.9, 0.3);
    state.enemies.push(createEnemy(state, spawn.kind, spawn.pos, `boss-phase-${phase}`, coopScale));
  }
}

function updateProjectiles(state: GameState, mission: Mission, dt: number) {
  const active: ProjectileState[] = [];
  for (const projectile of state.projectiles) {
    projectile.ttl -= dt;
    projectile.pos.x += projectile.vel.x * dt;
    projectile.pos.y += projectile.vel.y * dt;
    if (projectile.ttl <= 0 || getTile(mission, projectile.pos.x, projectile.pos.y).solid) {
      addImpact(state, projectile.kind === 'bossBeat' ? 'woodBurst' : 'spark', projectile.pos, 0.5, 0.45);
      continue;
    }
    const hitPlayer = playerIds.map((id) => state.players[id]).find((player) => player.alive && pointInCircle(projectile.pos, player.pos, projectile.radius + 0.2));
    if (hitPlayer) {
      damagePlayer(state, hitPlayer, projectile.damage, 0.35, projectile.pos);
      addImpact(state, projectile.kind === 'bossBeat' ? 'woodBurst' : 'spark', projectile.pos, 0.65, 0.45);
      continue;
    }
    active.push(projectile);
  }
  state.projectiles = active;
}

function addProjectile(
  state: GameState,
  kind: ProjectileState['kind'],
  owner: ProjectileState['owner'],
  origin: Vec2,
  angle: number,
  speed: number,
  damage: number,
  ttl: number,
) {
  state.projectiles.push({
    id: nextEntityId(state, kind),
    kind,
    owner,
    pos: { x: origin.x + Math.cos(angle) * 0.36, y: origin.y + Math.sin(angle) * 0.36 },
    vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    radius: kind === 'bossBeat' ? 0.22 : 0.13,
    damage,
    ttl,
  });
}

function damageEnemyState(state: GameState, attackerId: PlayerId, enemy: EnemyState, damage: number, angle: number, hitPoint: Vec2) {
  const previousHealth = enemy.health;
  enemy.health = Math.max(0, enemy.health - damage);
  recordDamage(state, attackerId, previousHealth - enemy.health);
  enemy.painTimer = 0.12;
  addImpact(state, 'blood', hitPoint, 0.75, enemyHitHeight(enemy.kind));
  const knockback = Math.min(0.16, 0.05 * (damage / 24));
  enemy.pos = {
    x: enemy.pos.x + Math.cos(angle) * knockback,
    y: enemy.pos.y + Math.sin(angle) * knockback,
  };
  if (enemy.health <= 0) {
    enemy.active = false;
    enemy.deathTimer = 0;
    recordKill(state, attackerId);
    addImpact(state, 'woodBurst', enemy.pos, 0.85, 0.3);
    maybeDropAmmo(state, enemy.pos);
  }
}

function damageBossState(state: GameState, attackerId: PlayerId, damage: number, angle: number, hitPoint: Vec2) {
  const boss = state.boss;
  const previousHealth = boss.health;
  boss.health = Math.max(0, boss.health - damage);
  recordDamage(state, attackerId, previousHealth - boss.health);
  boss.painTimer = 0.18;
  boss.pos = {
    x: boss.pos.x + Math.cos(angle) * 0.025,
    y: boss.pos.y + Math.sin(angle) * 0.025,
  };
  addImpact(state, 'woodBurst', hitPoint, 1.1, 0.6);
  if (boss.health <= 0) {
    recordKill(state, attackerId, 250);
    boss.defeated = true;
    boss.active = false;
    state.bossGateOpen = true;
    state.objective = 'Sahurwood is silent. Reach the extraction lift.';
    state.objectiveTimer = 8;
    for (let i = 0; i < 8; i += 1) {
      addImpact(state, i % 2 ? 'woodBurst' : 'spark', {
        x: boss.pos.x + Math.cos((i / 8) * Math.PI * 2) * 0.5,
        y: boss.pos.y + Math.sin((i / 8) * Math.PI * 2) * 0.5,
      }, 1, 0.5);
    }
  }
}

function maybeDropAmmo(state: GameState, pos: Vec2) {
  if (Math.sin(pos.x * 17 + pos.y * 31 + state.time) < 0.1) return;
  state.pickups.push({
    id: nextEntityId(state, 'drop'),
    kind: 'ammo',
    pos: { ...pos },
    radius: 0.3,
    amount: 10,
    taken: false,
  });
}

function damagePlayer(state: GameState, player: PlayerState, amount: number, shake = 0.2, sourcePos: Vec2 | null = null) {
  if (!player.alive || player.hurtTimer > 0.12) return;
  const armorBlock = Math.min(player.armor, amount * 0.45);
  player.armor = Math.max(0, player.armor - armorBlock);
  player.health = Math.max(0, player.health - (amount - armorBlock));
  player.hurtTimer = 0.35;
  player.lastHitAngle = sourcePos ? angleTo(player.pos, sourcePos) : null;
  player.faceAngryTimer = Math.max(player.faceAngryTimer, 0.55);
  player.shake = Math.max(player.shake, shake);
  if (player.health <= 0) {
    player.alive = false;
    player.deaths += 1;
    recordDeath(state, player.id);
    player.respawnTimer = player.deaths >= 3 ? 999 : 2.5;
    player.reloadWeapon = null;
    player.reloadTimer = 0;
    player.reloadDuration = 0;
    player.fireTimer = 0;
  }
}

function recordDamage(state: GameState, playerId: PlayerId, amount: number) {
  const applied = Math.max(0, amount);
  if (applied <= 0) return;
  const score = state.scores[playerId];
  score.damage += applied;
  score.total += Math.round(applied);
}

function recordKill(state: GameState, playerId: PlayerId, bonus = 100) {
  const score = state.scores[playerId];
  score.kills += 1;
  score.total += bonus;
}

function recordPickup(state: GameState, playerId: PlayerId) {
  const score = state.scores[playerId];
  score.pickups += 1;
  score.total += 10;
}

function recordDeath(state: GameState, playerId: PlayerId) {
  const score = state.scores[playerId];
  score.deaths += 1;
  score.total = Math.max(0, score.total - 25);
}

function moveActor(mission: Mission, props: GameState['props'], pos: Vec2, delta: Vec2, radius: number, z = 0) {
  const distanceToMove = Math.hypot(delta.x, delta.y);
  const steps = Math.max(1, Math.ceil(distanceToMove / maxMoveStep));
  let next = pos;
  for (let step = 0; step < steps; step += 1) {
    next = moveWithCollision(
      mission,
      props,
      next,
      { x: delta.x / steps, y: delta.y / steps },
      radius,
      z,
    );
  }
  return next;
}

function nearestAlivePlayer(state: GameState, point: Vec2, connectedPlayers: readonly PlayerId[]): PlayerState | null {
  // Disconnected avatars are ignored so enemies never farm an empty body.
  const alive = connectedPlayers.map((id) => state.players[id]).filter((player) => player.alive);
  if (!alive.length) return null;
  alive.sort((a, b) => distance(a.pos, point) - distance(b.pos, point));
  return alive[0];
}

function addImpact(state: GameState, kind: ImpactKind, pos: Vec2, scale: number, height = 0.45, owner?: PlayerId) {
  state.impacts.push({
    id: nextEntityId(state, kind),
    kind,
    pos: { ...pos },
    age: 0,
    // Muzzle ttl must outlive a 20Hz snapshot interval or remote flashes vanish between snapshots.
    ttl: kind === 'muzzle' ? 0.18 : 0.36,
    scale,
    height,
    owner,
  });
}

// Torso height (world units above floor) where shot effects should center per enemy size.
export function enemyHitHeight(kind: EnemyKind) {
  if (kind === 'drumImp') return 0.26;
  if (kind === 'rustAcolyte') return 0.46;
  return 0.42;
}

function updateImpacts(state: GameState, dt: number) {
  for (const impact of state.impacts) impact.age += dt;
  state.impacts = state.impacts.filter((impact) => impact.age < impact.ttl);
}

function updateMissionOutcome(state: GameState, mission: Mission, connectedPlayers: readonly PlayerId[]) {
  // Only connected marines count toward the wipe check; an empty slot can't keep the mission alive.
  const alive = connectedPlayers.filter((id) => state.players[id].alive || state.players[id].deaths < 3);
  if (alive.length === 0) {
    state.mode = 'lost';
    state.objective = 'You are down. Press R to restart.';
    return;
  }
  if (state.boss.defeated && playerIds.some((id) => state.players[id].alive && rectContains(mission.exitZone, state.players[id].pos))) {
    state.mode = 'won';
    state.objective = 'Extraction complete. Press R to replay the nightmare.';
  }
}

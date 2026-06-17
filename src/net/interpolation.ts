import { normalizeAngle, lerp } from '../game/core/math';
import type { BossState, EnemyState, GameState, PlayerId, PlayerState, ProjectileState } from '../game/core/types';
import type { CameraState, MoveState } from '../game/simulation';
import type { MultiplayerSnapshot } from './client';

export const INTERPOLATION_DELAY_MS = 110;

type BufferedSnapshot = {
  recvTime: number;
  snapshot: MultiplayerSnapshot;
};

export type SampledSnapshots = {
  older: MultiplayerSnapshot | null;
  newer: MultiplayerSnapshot;
  alpha: number;
};

// Snapshots are buffered by local receive time (no clock sync needed); remote entities are
// rendered ~INTERPOLATION_DELAY_MS in the past so there is always a pair to lerp between.
export class SnapshotBuffer {
  private entries: BufferedSnapshot[] = [];

  clear() {
    this.entries = [];
  }

  get length() {
    return this.entries.length;
  }

  push(snapshot: MultiplayerSnapshot, recvTime = performance.now()) {
    // A rewound simulation clock means the match restarted; stale entries must not blend in.
    const last = this.entries[this.entries.length - 1];
    if (last && snapshot.state.time < last.snapshot.state.time) this.entries = [];
    this.entries.push({ recvTime, snapshot });
    const cutoff = recvTime - 1000;
    while (this.entries.length > 2 && this.entries[0].recvTime < cutoff) this.entries.shift();
  }

  latest(): MultiplayerSnapshot | null {
    return this.entries[this.entries.length - 1]?.snapshot ?? null;
  }

  sample(now = performance.now()): SampledSnapshots | null {
    if (!this.entries.length) return null;
    const renderTime = now - INTERPOLATION_DELAY_MS;
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].recvTime <= renderTime) {
        const older = this.entries[i];
        const newer = this.entries[i + 1];
        if (!newer) return { older: null, newer: older.snapshot, alpha: 1 };
        const span = Math.max(1, newer.recvTime - older.recvTime);
        const alpha = Math.min(1, (renderTime - older.recvTime) / span);
        return { older: older.snapshot, newer: newer.snapshot, alpha };
      }
    }
    return { older: null, newer: this.entries[0].snapshot, alpha: 1 };
  }
}

export type LocalOverride = {
  pose: MoveState;
  camera: CameraState;
  fireTimer: number;
  weaponKick: number;
  muzzleTimer: number;
};

// Builds the state handed to the renderer: remote entities interpolated between the two
// bracketing snapshots, the local player overridden with the predicted pose + local camera.
export function buildRenderState(
  sample: SampledSnapshots,
  localId: PlayerId | null,
  local: LocalOverride | null,
): GameState {
  const newer = sample.newer.state;
  const older = sample.older?.state ?? null;
  const alpha = sample.alpha;
  if (!older && !local) return newer;

  const players = { ...newer.players };
  for (const id of Object.keys(players) as PlayerId[]) {
    if (id === localId && local && newer.mode === 'playing' && players[id].alive) {
      players[id] = {
        ...players[id],
        pos: local.pose.pos,
        angle: local.pose.angle,
        viewPos: local.camera.viewPos,
        viewAngle: local.camera.viewAngle,
        viewZ: local.camera.viewZ,
        bobPhase: local.camera.bobPhase,
        moveBlend: local.camera.moveBlend,
        fireTimer: Math.max(players[id].fireTimer, local.fireTimer),
        weaponKick: Math.max(players[id].weaponKick, local.weaponKick),
        muzzleTimer: Math.max(players[id].muzzleTimer, local.muzzleTimer),
      };
    } else if (older?.players[id]) {
      players[id] = interpolatePlayer(older.players[id], players[id], alpha);
    }
  }

  return {
    ...newer,
    players,
    enemies: older ? interpolateById(older.enemies, newer.enemies, alpha, interpolateEnemy) : newer.enemies,
    boss: older ? interpolateBoss(older.boss, newer.boss, alpha) : newer.boss,
    projectiles: older
      ? interpolateProjectiles(older, newer, alpha)
      : newer.projectiles,
  };
}

function interpolatePlayer(older: PlayerState, newer: PlayerState, alpha: number): PlayerState {
  if (!older.alive || !newer.alive) return newer;
  return {
    ...newer,
    pos: lerpVec(older.pos, newer.pos, alpha),
    viewPos: lerpVec(older.viewPos, newer.viewPos, alpha),
    angle: lerpAngle(older.angle, newer.angle, alpha),
    viewAngle: lerpAngle(older.viewAngle, newer.viewAngle, alpha),
    bobPhase: lerp(older.bobPhase, newer.bobPhase, alpha),
    moveBlend: lerp(older.moveBlend, newer.moveBlend, alpha),
  };
}

function interpolateEnemy(older: EnemyState, newer: EnemyState, alpha: number): EnemyState {
  if (newer.health <= 0) return newer;
  return {
    ...newer,
    pos: lerpVec(older.pos, newer.pos, alpha),
    facingAngle: lerpAngle(older.facingAngle, newer.facingAngle, alpha),
  };
}

function interpolateBoss(older: BossState, newer: BossState, alpha: number): BossState {
  if (!newer.active || newer.defeated) return newer;
  return {
    ...newer,
    pos: lerpVec(older.pos, newer.pos, alpha),
    facingAngle: lerpAngle(older.facingAngle, newer.facingAngle, alpha),
  };
}

function interpolateProjectiles(older: GameState, newer: GameState, alpha: number): ProjectileState[] {
  const olderById = new Map(older.projectiles.map((item) => [item.id, item]));
  const snapSpan = Math.max(0.001, newer.time - older.time);
  return newer.projectiles.map((projectile) => {
    const previous = olderById.get(projectile.id);
    if (previous) {
      return { ...projectile, pos: lerpVec(previous.pos, projectile.pos, alpha) };
    }
    // Just spawned: rewind along its velocity so it doesn't pop in ahead of the timeline.
    const rewind = (1 - alpha) * snapSpan;
    return {
      ...projectile,
      pos: {
        x: projectile.pos.x - projectile.vel.x * rewind,
        y: projectile.pos.y - projectile.vel.y * rewind,
      },
    };
  });
}

function interpolateById<T extends { id: string }>(
  older: T[],
  newer: T[],
  alpha: number,
  blend: (older: T, newer: T, alpha: number) => T,
): T[] {
  const olderById = new Map(older.map((item) => [item.id, item]));
  return newer.map((item) => {
    const previous = olderById.get(item.id);
    return previous ? blend(previous, item, alpha) : item;
  });
}

function lerpVec(a: { x: number; y: number }, b: { x: number; y: number }, alpha: number) {
  return { x: lerp(a.x, b.x, alpha), y: lerp(a.y, b.y, alpha) };
}

function lerpAngle(a: number, b: number, alpha: number) {
  return normalizeAngle(a + normalizeAngle(b - a) * alpha);
}

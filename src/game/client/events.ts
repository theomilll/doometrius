import type { Vec2 } from '../core/math';
import { distance } from '../core/math';
import { playerIds } from '../core/types';
import type {
  BossPhase,
  EnemyKind,
  GameState,
  ImpactKind,
  PickupKind,
  PlayerId,
  ProjectileKind,
  TeamState,
  WeaponId,
} from '../core/types';

export type GameEvent =
  | { type: 'impact'; kind: ImpactKind; pos: Vec2 }
  | { type: 'shot'; playerId: PlayerId; weapon: WeaponId; pos: Vec2 }
  | { type: 'dryFire'; playerId: PlayerId }
  | { type: 'reloadStart'; playerId: PlayerId; weapon: WeaponId }
  | { type: 'reloadEnd'; playerId: PlayerId; weapon: WeaponId }
  | { type: 'weaponSwitch'; playerId: PlayerId; weapon: WeaponId }
  | { type: 'hitConfirm'; playerId: PlayerId; amount: number }
  | { type: 'kill'; playerId: PlayerId; bossKill: boolean }
  | { type: 'pickup'; playerId: PlayerId; kind: PickupKind; pos: Vec2 }
  | { type: 'playerHurt'; playerId: PlayerId; sourceAngle: number | null }
  | { type: 'playerDied'; playerId: PlayerId }
  | { type: 'playerRespawned'; playerId: PlayerId }
  | { type: 'enemySpawned'; kind: EnemyKind; pos: Vec2 }
  | { type: 'enemyDied'; kind: EnemyKind; pos: Vec2 }
  | { type: 'projectileSpawned'; kind: ProjectileKind; pos: Vec2 }
  | { type: 'bossActivated' }
  | { type: 'bossPhase'; phase: BossPhase }
  | { type: 'bossDefeated' }
  | { type: 'modeChange'; mode: TeamState };

// Derives "what just happened" by diffing consecutive authoritative snapshots. This is the
// single event source for audio and HUD effects; the simulation never has to emit events.
export class EventTracker {
  private prev: GameState | null = null;
  private seenImpacts = new Set<string>();
  private seenProjectiles = new Set<string>();
  private seenEnemies = new Set<string>();

  reset() {
    this.prev = null;
    this.seenImpacts.clear();
    this.seenProjectiles.clear();
    this.seenEnemies.clear();
  }

  update(next: GameState): GameEvent[] {
    const prev = this.prev;
    this.prev = next;
    const events: GameEvent[] = [];

    if (!prev || next.time < prev.time) {
      // First snapshot or restart: seed the id sets without replaying history as events.
      this.seenImpacts = new Set(next.impacts.map((item) => item.id));
      this.seenProjectiles = new Set(next.projectiles.map((item) => item.id));
      this.seenEnemies = new Set(next.enemies.map((item) => item.id));
      return events;
    }

    if (next.mode !== prev.mode) events.push({ type: 'modeChange', mode: next.mode });

    for (const impact of next.impacts) {
      if (this.seenImpacts.has(impact.id)) continue;
      this.seenImpacts.add(impact.id);
      events.push({ type: 'impact', kind: impact.kind, pos: impact.pos });
    }
    if (this.seenImpacts.size > 256) this.pruneSeen(this.seenImpacts, next.impacts.map((item) => item.id));

    for (const projectile of next.projectiles) {
      if (this.seenProjectiles.has(projectile.id)) continue;
      this.seenProjectiles.add(projectile.id);
      events.push({ type: 'projectileSpawned', kind: projectile.kind, pos: projectile.pos });
    }
    if (this.seenProjectiles.size > 256) this.pruneSeen(this.seenProjectiles, next.projectiles.map((item) => item.id));

    const prevEnemies = new Map(prev.enemies.map((enemy) => [enemy.id, enemy]));
    for (const enemy of next.enemies) {
      if (!this.seenEnemies.has(enemy.id)) {
        this.seenEnemies.add(enemy.id);
        events.push({ type: 'enemySpawned', kind: enemy.kind, pos: enemy.pos });
      }
      const before = prevEnemies.get(enemy.id);
      if (before && before.health > 0 && enemy.health <= 0) {
        events.push({ type: 'enemyDied', kind: enemy.kind, pos: enemy.pos });
      }
    }
    if (this.seenEnemies.size > 512) this.pruneSeen(this.seenEnemies, next.enemies.map((item) => item.id));

    for (const id of playerIds) {
      const before = prev.players[id];
      const after = next.players[id];
      const score = next.scores[id];
      const prevScore = prev.scores[id];

      if (after.fireTimer > before.fireTimer + 0.001) {
        events.push({ type: 'shot', playerId: id, weapon: after.weapon, pos: after.pos });
      }
      if (after.dryFireTimer > before.dryFireTimer + 0.001) {
        events.push({ type: 'dryFire', playerId: id });
      }
      if (after.reloadWeapon && !before.reloadWeapon) {
        events.push({ type: 'reloadStart', playerId: id, weapon: after.reloadWeapon });
      }
      if (!after.reloadWeapon && before.reloadWeapon) {
        events.push({ type: 'reloadEnd', playerId: id, weapon: before.reloadWeapon });
      }
      if (after.weapon !== before.weapon) {
        events.push({ type: 'weaponSwitch', playerId: id, weapon: after.weapon });
      }
      if (score.damage > prevScore.damage) {
        events.push({ type: 'hitConfirm', playerId: id, amount: score.damage - prevScore.damage });
      }
      for (let i = prevScore.kills; i < score.kills; i += 1) {
        events.push({ type: 'kill', playerId: id, bossKill: next.boss.defeated && !prev.boss.defeated });
      }
      if (after.hurtTimer > before.hurtTimer + 0.001) {
        events.push({ type: 'playerHurt', playerId: id, sourceAngle: after.lastHitAngle });
      }
      if (!after.alive && before.alive) events.push({ type: 'playerDied', playerId: id });
      if (after.alive && !before.alive) events.push({ type: 'playerRespawned', playerId: id });

      if (score.pickups > prevScore.pickups) {
        const taken = next.pickups.filter((pickup) => {
          const prevPickup = prev.pickups.find((item) => item.id === pickup.id);
          return pickup.taken && prevPickup && !prevPickup.taken;
        });
        const nearest = taken.sort((a, b) => distance(a.pos, after.pos) - distance(b.pos, after.pos))[0];
        if (nearest) events.push({ type: 'pickup', playerId: id, kind: nearest.kind, pos: nearest.pos });
      }
    }

    if (next.boss.active && !prev.boss.active) events.push({ type: 'bossActivated' });
    if (next.boss.active && next.boss.phase !== prev.boss.phase) events.push({ type: 'bossPhase', phase: next.boss.phase });
    if (next.boss.defeated && !prev.boss.defeated) events.push({ type: 'bossDefeated' });

    return events;
  }

  private pruneSeen(seen: Set<string>, liveIds: string[]) {
    const live = new Set(liveIds);
    for (const id of seen) if (!live.has(id)) seen.delete(id);
  }
}

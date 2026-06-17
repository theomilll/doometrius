import type { Vec2 } from '../core/math';
import type { GameState, PickupKind, PlayerId } from '../core/types';
import type { GameEvent } from './events';

export type FeedEntry = { text: string; color: string; t: number };

export type Tracer = { to: Vec2; height: number; t: number };

export type FxState = {
  hitMarker: number;
  killMarker: number;
  feed: FeedEntry[];
  damageDirs: { angle: number; t: number }[];
  scoreDelta: { value: number; t: number } | null;
  screenFlash: { color: string; alpha: number; t: number; duration: number } | null;
  hudBumps: { health: number; ammo: number };
  bossBarFlash: number;
  respawnFade: number;
  lastKillAt: number;
  tracers: Tracer[];
};

const FEED_TTL = 4;
const FEED_MAX = 5;

export function createFxState(): FxState {
  return {
    hitMarker: 0,
    killMarker: 0,
    feed: [],
    damageDirs: [],
    scoreDelta: null,
    screenFlash: null,
    hudBumps: { health: 0, ammo: 0 },
    bossBarFlash: 0,
    respawnFade: 0,
    lastKillAt: -10,
    tracers: [],
  };
}

export function addTracer(fx: FxState, to: Vec2, height: number) {
  fx.tracers.push({ to, height, t: 0.08 });
  while (fx.tracers.length > 8) fx.tracers.shift();
}

export function applyFxEvents(fx: FxState, events: GameEvent[], state: GameState, localId: PlayerId | null) {
  for (const event of events) {
    switch (event.type) {
      case 'hitConfirm':
        if (event.playerId === localId) {
          fx.hitMarker = 0.09;
          bumpScore(fx, Math.round(event.amount));
        }
        break;
      case 'kill': {
        const name = state.players[event.playerId].name;
        if (event.playerId === localId) {
          fx.killMarker = 0.22;
          bumpScore(fx, event.bossKill ? 250 : 100);
        }
        if (event.bossKill) {
          pushFeed(fx, 'SAHURWOOD IS SILENCED', '#ffbe46');
        } else {
          pushFeed(fx, `${name} scored a kill`, '#e7d9bd');
        }
        if (state.time - fx.lastKillAt < 1.2) pushFeed(fx, 'DOUBLE KILL', '#ff8c4a');
        fx.lastKillAt = state.time;
        break;
      }
      case 'pickup': {
        const name = state.players[event.playerId].name;
        pushFeed(fx, `${name} grabbed ${pickupLabel(event.kind)}`, '#9fd0a5');
        if (event.playerId === localId) {
          bumpScore(fx, 10);
          if (event.kind === 'medkit' || event.kind === 'armor') fx.hudBumps.health = 0.3;
          else fx.hudBumps.ammo = 0.3;
        }
        break;
      }
      case 'playerHurt':
        if (event.playerId === localId && event.sourceAngle !== null) {
          fx.damageDirs.push({ angle: event.sourceAngle, t: 0.9 });
          if (fx.damageDirs.length > 4) fx.damageDirs.shift();
        }
        break;
      case 'playerDied':
        pushFeed(fx, `${state.players[event.playerId].name} IS DOWN`, '#ff6358');
        break;
      case 'playerRespawned':
        pushFeed(fx, `${state.players[event.playerId].name} is back up`, '#9fd0a5');
        if (event.playerId === localId) fx.respawnFade = 0.45;
        break;
      case 'bossActivated':
        pushFeed(fx, 'SAHURWOOD AWAKENS', '#ffbe46');
        fx.screenFlash = { color: '255, 170, 60', alpha: 0.26, t: 0.5, duration: 0.5 };
        fx.bossBarFlash = 0.4;
        break;
      case 'bossPhase':
        pushFeed(fx, event.phase === 3 ? 'FINAL RHYTHM' : 'THE RHYTHM QUICKENS', '#ffbe46');
        fx.screenFlash = { color: '255, 170, 60', alpha: 0.3, t: 0.45, duration: 0.45 };
        fx.bossBarFlash = 0.35;
        break;
      case 'modeChange':
        if (event.mode === 'playing') fx.screenFlash = { color: '255, 230, 180', alpha: 0.18, t: 0.3, duration: 0.3 };
        break;
      default:
        break;
    }
  }
}

export function updateFx(fx: FxState, dt: number) {
  fx.hitMarker = Math.max(0, fx.hitMarker - dt);
  fx.killMarker = Math.max(0, fx.killMarker - dt);
  fx.bossBarFlash = Math.max(0, fx.bossBarFlash - dt);
  fx.respawnFade = Math.max(0, fx.respawnFade - dt);
  fx.hudBumps.health = Math.max(0, fx.hudBumps.health - dt);
  fx.hudBumps.ammo = Math.max(0, fx.hudBumps.ammo - dt);
  for (const entry of fx.feed) entry.t += dt;
  fx.feed = fx.feed.filter((entry) => entry.t < FEED_TTL);
  for (const dir of fx.damageDirs) dir.t -= dt;
  fx.damageDirs = fx.damageDirs.filter((dir) => dir.t > 0);
  for (const tracer of fx.tracers) tracer.t -= dt;
  fx.tracers = fx.tracers.filter((tracer) => tracer.t > 0);
  if (fx.scoreDelta) {
    fx.scoreDelta.t -= dt;
    if (fx.scoreDelta.t <= 0) fx.scoreDelta = null;
  }
  if (fx.screenFlash) {
    fx.screenFlash.t -= dt;
    if (fx.screenFlash.t <= 0) fx.screenFlash = null;
  }
}

function bumpScore(fx: FxState, value: number) {
  if (fx.scoreDelta && fx.scoreDelta.t > 0) {
    fx.scoreDelta.value += value;
    fx.scoreDelta.t = Math.max(fx.scoreDelta.t, 0.8);
  } else {
    fx.scoreDelta = { value, t: 0.8 };
  }
}

function pushFeed(fx: FxState, text: string, color: string) {
  fx.feed.push({ text, color, t: 0 });
  while (fx.feed.length > FEED_MAX) fx.feed.shift();
}

function pickupLabel(kind: PickupKind) {
  switch (kind) {
    case 'medkit':
      return 'a medkit';
    case 'ammo':
      return 'stake rounds';
    case 'shells':
      return 'rib shells';
    case 'armor':
      return 'bone armor';
  }
}


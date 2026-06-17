import { distance, normalizeAngle, type Vec2 } from '../core/math';
import type { GameState, PlayerId, WeaponId } from '../core/types';
import type { GameEvent } from '../client/events';
import { buildSoundBank, type SoundName } from './synth';
import { MusicEngine, type MusicIntensity } from './music';

const STORAGE_KEY = 'frontier-audio';
const MAX_HEARABLE_DISTANCE = 18;
const MUSIC_BUS_LEVEL = 0.32;

type PlayOptions = {
  volume?: number;
  rate?: number;
  pan?: number;
};

type Settings = { muted: boolean; volume: number };

const weaponSound: Record<WeaponId, SoundName> = {
  stakePistol: 'pistol',
  ribShotgun: 'shotgun',
};

// All playback goes through buffer sources with +-6% rate jitter so repeats never sound
// robotic. Spatial sounds get distance falloff + stereo pan relative to the listener.
export class SoundManager {
  private ctx: AudioContext | null = null;
  private bank: Map<SoundName, AudioBuffer> | null = null;
  private masterGain: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private music: MusicEngine | null = null;
  private musicStarted = false;
  private listenerPos: Vec2 = { x: 0, y: 0 };
  private listenerAngle = 0;
  private settings: Settings = loadSettings();
  private activeCounts = new Map<SoundName, number>();
  private lastGrowlAt = -10;
  private heartbeatIn = 0;
  private lastStepSign = 0;

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.settings.muted ? 0 : this.settings.volume;
    this.masterGain.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.masterGain);
    const musicBus = this.ctx.createGain();
    musicBus.gain.value = MUSIC_BUS_LEVEL;
    musicBus.connect(this.masterGain);
    this.bank = buildSoundBank(this.ctx);
    this.music = new MusicEngine(this.ctx, musicBus);
  }

  // AudioContext starts suspended until a user gesture; call from click/keydown handlers.
  resume() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.musicStarted && this.ctx.state !== 'closed') {
      this.musicStarted = true;
      this.music?.start();
    }
  }

  dispose() {
    this.music?.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.bank = null;
  }

  isMuted() {
    return this.settings.muted;
  }

  setMuted(muted: boolean) {
    this.settings = { ...this.settings, muted };
    saveSettings(this.settings);
    this.applyMaster();
  }

  volume() {
    return this.settings.volume;
  }

  setVolume(volume: number) {
    this.settings = { ...this.settings, volume: Math.max(0, Math.min(1, volume)) };
    saveSettings(this.settings);
    this.applyMaster();
  }

  setListener(pos: Vec2, angle: number) {
    this.listenerPos = pos;
    this.listenerAngle = angle;
  }

  play(name: SoundName, opts: PlayOptions = {}) {
    if (!this.ctx || !this.bank || !this.sfxBus || this.settings.muted) return;
    if (this.ctx.state !== 'running') return;
    const buffer = this.bank.get(name);
    if (!buffer) return;
    const count = this.activeCounts.get(name) ?? 0;
    if (count >= 3) return;
    this.activeCounts.set(name, count + 1);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.sfxBus);
    source.addEventListener('ended', () => {
      this.activeCounts.set(name, Math.max(0, (this.activeCounts.get(name) ?? 1) - 1));
    });
    source.start();
  }

  playAt(name: SoundName, pos: Vec2, opts: PlayOptions = {}) {
    const dist = distance(pos, this.listenerPos);
    if (dist > MAX_HEARABLE_DISTANCE) return;
    const falloff = 1 / (1 + dist * 0.55);
    const relative = normalizeAngle(Math.atan2(pos.y - this.listenerPos.y, pos.x - this.listenerPos.x) - this.listenerAngle);
    this.play(name, {
      ...opts,
      volume: (opts.volume ?? 1) * falloff,
      pan: Math.sin(relative) * 0.75,
    });
  }

  handleEvents(events: GameEvent[], state: GameState, localId: PlayerId | null) {
    for (const event of events) {
      switch (event.type) {
        case 'impact':
          if (event.kind === 'blood') this.playAt('splat', event.pos, { volume: 0.8 });
          else if (event.kind === 'spark') this.playAt('ricochet', event.pos, { volume: 0.5 });
          else if (event.kind === 'woodBurst') this.playAt('woodBreak', event.pos, { volume: 0.9 });
          break;
        case 'shot':
          // The local player's shot is played immediately by the client fire handler.
          if (event.playerId !== localId) this.playAt(weaponSound[event.weapon], event.pos, { volume: 0.85 });
          break;
        case 'dryFire':
          if (event.playerId === localId) this.play('dryClick', { volume: 0.8 });
          break;
        case 'reloadStart':
          this.playForPlayer(event.playerId, localId, state, 'reloadClipOut', 0.7);
          break;
        case 'reloadEnd':
          this.playForPlayer(event.playerId, localId, state, 'reloadClipIn', 0.7);
          break;
        case 'weaponSwitch':
          this.playForPlayer(event.playerId, localId, state, 'weaponSwitch', 0.7);
          break;
        case 'pickup':
          this.playForPlayer(event.playerId, localId, state, pickupSound(event.kind), 0.9);
          break;
        case 'playerHurt':
          if (event.playerId === localId) this.play('hurt', { volume: 0.9 });
          else this.playAt('hurt', state.players[event.playerId].pos, { volume: 0.55 });
          break;
        case 'playerDied':
          this.playForPlayer(event.playerId, localId, state, 'hurt', 1, 0.6);
          break;
        case 'enemySpawned': {
          const now = state.time;
          if (now - this.lastGrowlAt > 1.5) {
            this.lastGrowlAt = now;
            this.playAt('growl', event.pos, { volume: 0.8 });
          }
          break;
        }
        case 'enemyDied':
          this.playAt('enemyDeath', event.pos, { volume: 0.85 });
          break;
        case 'projectileSpawned':
          if (event.kind === 'bossBeat') this.playAt('bossBeat', event.pos, { volume: 0.9 });
          else this.playAt('whoosh', event.pos, { volume: 0.45 });
          break;
        case 'bossActivated':
          this.play('bossRoar', { volume: 1 });
          break;
        case 'bossPhase':
          this.play('bossRoar', { volume: 1, rate: event.phase === 3 ? 0.85 : 1 });
          break;
        case 'bossDefeated':
          this.play('bossRoar', { volume: 0.9, rate: 0.7 });
          break;
        case 'modeChange':
          if (event.mode === 'won') this.play('stingerWin');
          else if (event.mode === 'lost') this.play('stingerLose');
          else if (event.mode === 'playing') this.play('uiClick');
          break;
        default:
          break;
      }
    }
  }

  // Per-frame ambience driven by the rendered state: heartbeat, footsteps, music intensity.
  tick(state: GameState, localId: PlayerId | null, dt: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const player = localId ? state.players[localId] : null;
    if (!player) return;

    if (player.alive && state.mode === 'playing' && player.health <= 30) {
      this.heartbeatIn -= dt;
      if (this.heartbeatIn <= 0) {
        const urgency = Math.max(0, Math.min(1, 1 - player.health / 30));
        this.heartbeatIn = 1.1 - urgency * 0.45;
        this.play('heartbeat', { volume: 0.6 + urgency * 0.3 });
      }
    } else {
      this.heartbeatIn = 0;
    }

    if (player.alive && player.moveBlend > 0.5) {
      const sign = Math.sign(Math.sin(player.bobPhase));
      if (sign !== 0 && sign !== this.lastStepSign) {
        this.lastStepSign = sign;
        this.play('footstep', { volume: 0.4, rate: sign > 0 ? 1 : 0.94 });
      }
    }

    const bossFight = state.boss.active && !state.boss.defeated;
    let intensity: MusicIntensity = 0;
    if (bossFight) intensity = state.boss.phase === 3 || (player.alive && player.health <= 30) ? 2 : 1;
    this.music?.setIntensity(intensity);
  }

  // Local player's own sounds play centered/full; everyone else is spatialized.
  private playForPlayer(playerId: PlayerId, localId: PlayerId | null, state: GameState, name: SoundName, volume: number, rate = 1) {
    if (playerId === localId) this.play(name, { volume, rate });
    else this.playAt(name, state.players[playerId].pos, { volume: volume * 0.7, rate });
  }

  private applyMaster() {
    if (!this.masterGain || !this.ctx) return;
    this.masterGain.gain.linearRampToValueAtTime(
      this.settings.muted ? 0 : this.settings.volume,
      this.ctx.currentTime + 0.08,
    );
  }
}

function pickupSound(kind: 'medkit' | 'ammo' | 'shells' | 'armor'): SoundName {
  switch (kind) {
    case 'medkit':
      return 'pickupHealth';
    case 'ammo':
      return 'pickupAmmo';
    case 'shells':
      return 'pickupShells';
    case 'armor':
      return 'pickupArmor';
  }
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        muted: Boolean(parsed.muted),
        volume: typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : 0.8,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { muted: false, volume: 0.8 };
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // best effort
  }
}

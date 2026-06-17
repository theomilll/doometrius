import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { loadAssets, type LoadedAssets } from '../game/assets/manifest';
import type { GameState, PlayerId } from '../game/core/types';
import { InputManager } from '../game/input';
import { getRuntimeMission } from '../game/mission/runtime';
import { renderGame } from '../game/render/raycaster';
import { weapons } from '../game/weapons';
import { EventTracker } from '../game/client/events';
import { addTracer, applyFxEvents, createFxState, updateFx } from '../game/client/fx';
import { enemyHitHeight, findHitscanTarget } from '../game/simulation';
import { SoundManager } from '../game/audio/manager';
import { MultiplayerClient, type MultiplayerSnapshot, type MultiplayerStatus } from '../net/client';
import { LocalPredictor, LocalView } from '../net/prediction';
import { buildRenderState, SnapshotBuffer } from '../net/interpolation';
import { sanitizeInput } from '../net/protocol';

const mission = getRuntimeMission();
const INPUT_RATE_HZ = 60;

type DebugWindow = Window & {
  __frontierMultiplayer?: {
    playerId: PlayerId | null;
    status: MultiplayerStatus;
    state: GameState | null;
    predictedPos: { x: number; y: number } | null;
    serverPos: { x: number; y: number } | null;
    pendingCount: number;
    interpBufferLen: number;
    bytesPerSecond: number;
  };
};

type LocalFire = { fireTimer: number; weaponKick: number; muzzleTimer: number; cooldown: number };

type HudInfo = {
  playerId: PlayerId | null;
  mode: GameState['mode'] | null;
  connected: string;
  scores: string;
};

export function DoomGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerIdRef = useRef<PlayerId | null>(null);
  const inputRef = useRef(new InputManager());
  const assetsRef = useRef<LoadedAssets | null>(null);
  const clientRef = useRef<MultiplayerClient | null>(null);
  const bufferRef = useRef(new SnapshotBuffer());
  const predictorRef = useRef(new LocalPredictor(mission));
  const localViewRef = useRef(new LocalView());
  const trackerRef = useRef(new EventTracker());
  const fxRef = useRef(createFxState());
  const soundsRef = useRef(new SoundManager());
  const sequenceRef = useRef(0);
  const movingRef = useRef({ moving: false, sprinting: false });
  const localFireRef = useRef<LocalFire>({ fireTimer: 0, weaponKick: 0, muzzleTimer: 0, cooldown: 0 });
  const [assetStatus, setAssetStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [networkStatus, setNetworkStatus] = useState<MultiplayerStatus>('connecting');
  const [message, setMessage] = useState('');
  const [hudInfo, setHudInfo] = useState<HudInfo>({ playerId: null, mode: null, connected: 'P1:empty  P2:empty', scores: '' });
  const [muted, setMuted] = useState(() => soundsRef.current.isMuted());
  const [volume, setVolume] = useState(() => soundsRef.current.volume());

  useEffect(() => {
    let cancelled = false;
    loadAssets()
      .then((assets) => {
        if (cancelled) return;
        assetsRef.current = assets;
        setAssetStatus('ready');
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setMessage(reason instanceof Error ? reason.message : String(reason));
        setAssetStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => inputRef.current.bind(window), []);

  // AudioContext can only start after a user gesture.
  useEffect(() => {
    const sounds = soundsRef.current;
    const resume = () => sounds.resume();
    window.addEventListener('keydown', resume);
    window.addEventListener('pointerdown', resume);
    return () => {
      window.removeEventListener('keydown', resume);
      window.removeEventListener('pointerdown', resume);
      sounds.dispose();
    };
  }, []);

  useEffect(() => {
    const client = new MultiplayerClient({
      status: (status, nextMessage) => {
        setNetworkStatus(status);
        if (nextMessage) setMessage(nextMessage);
      },
      welcome: (nextPlayerId) => {
        playerIdRef.current = nextPlayerId;
        predictorRef.current.reset();
        localViewRef.current.reset();
        bufferRef.current.clear();
        trackerRef.current.reset();
      },
      snapshot: (snapshot) => {
        playerIdRef.current = snapshot.playerId;
        bufferRef.current.push(snapshot);
        if (snapshot.playerId) {
          predictorRef.current.reconcile(snapshot.state, snapshot.playerId, snapshot.lastProcessedInput);
          inputRef.current.setKnownWeapon(snapshot.state.players[snapshot.playerId].weapon);
        }
        const events = trackerRef.current.update(snapshot.state);
        soundsRef.current.handleEvents(events, snapshot.state, snapshot.playerId);
        applyFxEvents(fxRef.current, events, snapshot.state, snapshot.playerId);
        updateHudInfo(snapshot);
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateHudInfo = (snapshot: MultiplayerSnapshot) => {
    const connected = snapshot.connectedPlayers
      .map((player) => `${player.id.toUpperCase()}:${player.connected ? 'online' : 'empty'}`)
      .join('  ');
    const scores = `P1 ${snapshot.state.scores.p1.total} / P2 ${snapshot.state.scores.p2.total}`;
    setHudInfo((current) => {
      if (
        current.playerId === snapshot.playerId
        && current.mode === snapshot.state.mode
        && current.connected === connected
        && current.scores === scores
      ) {
        return current;
      }
      return { playerId: snapshot.playerId, mode: snapshot.state.mode, connected, scores };
    });
  };

  // Fixed-rate input loop: sample, predict locally, send to the authority server.
  useEffect(() => {
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const client = clientRef.current;
      const playerId = playerIdRef.current;
      const latest = bufferRef.current.latest();
      const input = sanitizeInput(inputRef.current.read());
      movingRef.current = { moving: Math.hypot(input.forward, input.strafe) > 0, sprinting: input.sprint };

      sequenceRef.current += 1;
      client?.sendInput(sequenceRef.current, input);

      if (playerId && latest) {
        predictorRef.current.applyLocal(latest.state, playerId, sequenceRef.current, input, dt);
        if (input.shoot) tryLocalFire(latest.state, playerId);
      }
    }, 1000 / INPUT_RATE_HZ);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zero-latency fire feedback: flash/kick/sound/tracers immediately when the server is
  // expected to accept the shot. Damage, ammo and impacts remain fully server-authoritative.
  const tryLocalFire = (state: GameState, playerId: PlayerId) => {
    const fire = localFireRef.current;
    const player = state.players[playerId];
    if (state.mode !== 'playing' || !player.alive || player.reloadWeapon) return;
    if (fire.cooldown > 0) return;
    const weapon = weapons[player.weapon];
    if (player.magazines[player.weapon] < weapon.ammoCost) return;
    fire.cooldown = weapon.cooldown;
    fire.fireTimer = weapon.fireDuration;
    fire.weaponKick = weapon.recoil;
    fire.muzzleTimer = weapon.muzzleDuration;
    soundsRef.current.play(player.weapon === 'ribShotgun' ? 'shotgun' : 'pistol', { volume: 0.9 });

    // Cosmetic tracers: client-side hitscan from the predicted pose (same spread formula
    // as the server, minus its per-shot jitter) so streaks land where shots land.
    const pose = predictorRef.current.currentPose();
    const origin = pose?.pos ?? player.pos;
    const aimAngle = pose?.angle ?? player.angle;
    for (let pellet = 0; pellet < weapon.pelletCount; pellet += 1) {
      const spreadIndex = weapon.pelletCount === 1 ? 0 : pellet / (weapon.pelletCount - 1) - 0.5;
      const shotAngle = aimAngle + spreadIndex * weapon.spread;
      const hit = findHitscanTarget(state, mission, origin, shotAngle, weapon.range);
      const to = hit
        ? hit.point
        : { x: origin.x + Math.cos(shotAngle) * weapon.range, y: origin.y + Math.sin(shotAngle) * weapon.range };
      const height = hit?.kind === 'enemy' ? enemyHitHeight(hit.target.kind) : hit?.kind === 'boss' ? 0.6 : 0.45;
      addTracer(fxRef.current, to, height);
    }
  };

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const canvas = canvasRef.current;
      const assets = assetsRef.current;
      const playerId = playerIdRef.current;
      const sample = bufferRef.current.sample(now);

      const fire = localFireRef.current;
      fire.cooldown = Math.max(0, fire.cooldown - dt);
      fire.fireTimer = Math.max(0, fire.fireTimer - dt);
      fire.weaponKick = Math.max(0, fire.weaponKick - dt * 8);
      fire.muzzleTimer = Math.max(0, fire.muzzleTimer - dt);
      updateFx(fxRef.current, dt);

      if (canvas && assets && sample) {
        const pose = playerId ? predictorRef.current.renderPose(dt) : null;
        const local = pose
          ? {
              pose,
              camera: localViewRef.current.update(pose, movingRef.current.moving, movingRef.current.sprinting, dt),
              fireTimer: fire.fireTimer,
              weaponKick: fire.weaponKick,
              muzzleTimer: fire.muzzleTimer,
            }
          : null;
        const renderState = buildRenderState(sample, playerId, local);
        const viewId = playerId ?? 'p1';
        const viewer = renderState.players[viewId];
        soundsRef.current.setListener(viewer.pos, viewer.viewAngle);
        soundsRef.current.tick(renderState, playerId, dt);

        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const width = Math.max(320, rect.width);
        const height = Math.max(320, rect.height);
        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          renderGame(ctx, { width, height }, renderState, mission, assets, viewId, fxRef.current);
        }

        const debugWindow = window as DebugWindow;
        debugWindow.__frontierMultiplayer = {
          playerId,
          status: 'connected',
          state: bufferRef.current.latest()?.state ?? null,
          predictedPos: predictorRef.current.predictedPos(),
          serverPos: playerId ? bufferRef.current.latest()?.state.players[playerId].pos ?? null : null,
          pendingCount: predictorRef.current.pendingCount,
          interpBufferLen: bufferRef.current.length,
          bytesPerSecond: clientRef.current?.bytesPerSecond() ?? 0,
        };
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restart = () => {
    soundsRef.current.play('uiClick');
    clientRef.current?.requestRestart();
  };

  const toggleMute = () => {
    const next = !soundsRef.current.isMuted();
    soundsRef.current.setMuted(next);
    setMuted(next);
    if (!next) soundsRef.current.play('uiClick');
  };

  const changeVolume = (value: number) => {
    soundsRef.current.setVolume(value);
    setVolume(value);
  };

  const lockPointer = (event: React.MouseEvent<HTMLCanvasElement>) => {
    soundsRef.current.resume();
    inputRef.current.primePrimaryClick();
    inputRef.current.armMouseLook(event.clientX);
    try {
      void Promise.resolve(canvasRef.current?.requestPointerLock()).catch(() => undefined);
    } catch {
      // Pointer lock can be denied in automated or restricted browser contexts.
    }
  };

  const overlay = useMemo(() => {
    if (assetStatus === 'error') return { kind: 'error', text: message };
    if (networkStatus === 'error') return { kind: 'error', text: message || 'Unable to reach the game server.' };
    if (assetStatus === 'loading') return { kind: 'loading', text: 'Loading generated assets...' };
    if (networkStatus === 'connecting') return { kind: 'loading', text: message || 'Connecting to authoritative game server...' };
    if (networkStatus === 'disconnected') return { kind: 'loading', text: message || 'Reconnecting to game server...' };
    if (!hudInfo.mode) return { kind: 'loading', text: 'Waiting for first server snapshot...' };
    return null;
  }, [assetStatus, message, networkStatus, hudInfo.mode]);

  return (
    <main className="game-shell">
      <div className="game-toolbar">
        <div className="game-title">Doometrius</div>
        <div className="net-panel" data-testid="network-panel">
          <span>{networkStatus}</span>
          <span>{hudInfo.playerId ? `You are ${hudInfo.playerId.toUpperCase()}` : 'Spectator'}</span>
          <span>{hudInfo.connected}</span>
          {hudInfo.scores && <span>{hudInfo.scores}</span>}
        </div>
        <div className="toolbar-actions">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            aria-label="Volume"
            title="Volume"
            style={{ width: 70 }}
          />
          <button className="icon-button" type="button" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <button className="icon-button" type="button" onClick={restart} aria-label="Restart mission" title="Restart mission">
            <RotateCcw size={18} />
          </button>
        </div>
      </div>
      <div className="game-frame">
        <canvas ref={canvasRef} className="game-canvas" onClick={lockPointer} />
        {overlay && <div className={`load-panel ${overlay.kind === 'error' ? 'error' : ''}`}>{overlay.text}</div>}
      </div>
    </main>
  );
}

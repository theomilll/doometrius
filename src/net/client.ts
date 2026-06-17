import { DEFAULT_GAME_SERVER_PORT, type ClientMessage, type ConnectedPlayer, type ServerMessage } from './protocol';
import type { PlayerInput } from '../game/input';
import type { GameState, PlayerId } from '../game/core/types';

export type MultiplayerStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export type MultiplayerSnapshot = {
  playerId: PlayerId | null;
  connectedPlayers: ConnectedPlayer[];
  serverTime: number;
  lastProcessedInput: number;
  state: GameState;
};

export type MultiplayerClientEvents = {
  status: (status: MultiplayerStatus, message?: string) => void;
  welcome: (playerId: PlayerId | null) => void;
  snapshot: (snapshot: MultiplayerSnapshot) => void;
};

const RESUME_TOKEN_KEY = 'frontier-resume-token';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

// Optional artificial latency for feel-testing internet conditions locally.
const fakeLatencyMs = Number(import.meta.env.VITE_FAKE_LATENCY_MS ?? 0) || 0;
const fakeJitterMs = Number(import.meta.env.VITE_FAKE_JITTER_MS ?? 0) || 0;

export class MultiplayerClient {
  private socket: WebSocket | null = null;
  private playerId: PlayerId | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bytesReceived = 0;
  private bytesWindowStart = performance.now();
  private bytesPerSecondValue = 0;

  constructor(private readonly events: MultiplayerClientEvents) {}

  connect() {
    if (this.closed) return;
    const url = resolveServerUrl();
    this.events.status('connecting', `Connecting to ${url}`);
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempts = 0;
      this.events.status('connected');
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.trackBytes(event.data);
      withFakeLatency(() => this.handleMessage(event.data));
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.events.status('disconnected', 'Game server connection lost. Reconnecting...');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.events.status('error', 'Unable to reach the game server. Retrying...');
      socket.close();
    });
  }

  private handleMessage(data: unknown) {
    const message = decodeServerMessage(data);
    if (!message) return;
    if (message.type === 'welcome') {
      this.playerId = message.playerId;
      storeResumeToken(message.resumeToken);
      this.events.welcome(message.playerId);
    } else if (message.type === 'snapshot') {
      this.playerId = message.playerId;
      this.events.snapshot(message);
    } else {
      this.events.status('error', message.message);
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  sendInput(sequence: number, input: PlayerInput) {
    if (!this.isOpen()) return;
    this.send({ type: 'input', sequence, input });
  }

  requestRestart() {
    if (!this.isOpen()) return;
    this.send({ type: 'restart' });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  assignedPlayer() {
    return this.playerId;
  }

  bytesPerSecond() {
    return this.bytesPerSecondValue;
  }

  private trackBytes(data: unknown) {
    if (typeof data === 'string') this.bytesReceived += data.length;
    const now = performance.now();
    const elapsed = now - this.bytesWindowStart;
    if (elapsed >= 1000) {
      this.bytesPerSecondValue = (this.bytesReceived * 1000) / elapsed;
      this.bytesReceived = 0;
      this.bytesWindowStart = now;
    }
  }

  private isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(message: ClientMessage) {
    const socket = this.socket;
    if (!socket) return;
    const payload = JSON.stringify(message);
    withFakeLatency(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    });
  }
}

function withFakeLatency(action: () => void) {
  if (fakeLatencyMs <= 0 && fakeJitterMs <= 0) {
    action();
    return;
  }
  setTimeout(action, fakeLatencyMs / 2 + Math.random() * fakeJitterMs);
}

function storeResumeToken(token: string) {
  try {
    sessionStorage.setItem(RESUME_TOKEN_KEY, token);
  } catch {
    // Storage can be unavailable in some embedded contexts; resume is best-effort.
  }
}

function readResumeToken(): string | null {
  try {
    return sessionStorage.getItem(RESUME_TOKEN_KEY);
  } catch {
    return null;
  }
}

function resolveServerUrl() {
  const configured = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  const base = configured
    ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:${DEFAULT_GAME_SERVER_PORT}`;
  const token = readResumeToken();
  if (!token) return base;
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function decodeServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    return null;
  }
}

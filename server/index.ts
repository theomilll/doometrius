import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createGameState } from '../src/game/core/state';
import { playerIds, type PlayerId } from '../src/game/core/types';
import type { PlayerInput } from '../src/game/input';
import { getRuntimeMission } from '../src/game/mission/runtime';
import { createNeutralInput, updateGame, type Inputs } from '../src/game/simulation';
import { DEFAULT_GAME_SERVER_PORT, sanitizeInput, type ClientMessage, type ConnectedPlayer, type ServerMessage } from '../src/net/protocol';

const tickRate = 60;
const snapshotRate = 20;
const inputTimeoutMs = 400;
const slotReservationMs = 15_000;
const port = Number(process.env.GAME_SERVER_PORT ?? DEFAULT_GAME_SERVER_PORT);
const host = process.env.GAME_SERVER_HOST ?? '0.0.0.0';

const mission = getRuntimeMission();
let state = createGameState(mission);

type Client = {
  id: string;
  socket: WebSocket;
  playerId: PlayerId | null;
  resumeToken: string;
  input: PlayerInput;
  lastInputAt: number;
  lastSequence: number;
  lastProcessedSequence: number;
  isAlive: boolean;
};

const clients = new Map<WebSocket, Client>();
const reservedSlots = new Map<string, { playerId: PlayerId; expires: number }>();

const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      players: connectedPlayers(),
      mode: state.mode,
    }));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not found');
});

const websocketServer = new WebSocketServer({ server: httpServer, perMessageDeflate: true });

websocketServer.on('connection', (socket, request) => {
  const offeredToken = resumeTokenFromUrl(request.url);
  const client: Client = {
    id: randomUUID(),
    socket,
    playerId: claimPlayerSlot(offeredToken),
    resumeToken: offeredToken ?? randomUUID(),
    input: createNeutralInput(),
    lastInputAt: 0,
    lastSequence: -1,
    lastProcessedSequence: -1,
    isAlive: true,
  };
  clients.set(socket, client);
  socket.on('pong', () => {
    client.isAlive = true;
  });

  send(socket, {
    type: 'welcome',
    clientId: client.id,
    playerId: client.playerId,
    resumeToken: client.resumeToken,
    tickRate,
    snapshotRate,
  });
  sendSnapshot(client);
  broadcastSnapshots();

  socket.on('message', (data) => {
    const message = decodeClientMessage(data);
    if (!message) {
      send(socket, { type: 'error', message: 'Invalid client message.' });
      return;
    }
    handleClientMessage(client, message);
  });

  socket.on('close', () => {
    clients.delete(socket);
    if (client.playerId) {
      reservedSlots.set(client.resumeToken, {
        playerId: client.playerId,
        expires: Date.now() + slotReservationMs,
      });
    }
    broadcastSnapshots();
  });
});

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  updateGame(state, mission, collectInputs(now), dt, {
    connectedPlayers: connectedPlayers(),
  });
  consumeOneShotInputs();
}, 1000 / tickRate);

setInterval(() => {
  broadcastSnapshots();
}, 1000 / snapshotRate);

// Heartbeat: clients that vanish without a TCP close (crashed browser, dropped network)
// would otherwise hold their player slot forever.
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.isAlive) {
      client.socket.terminate();
      continue;
    }
    client.isAlive = false;
    client.socket.ping();
  }
}, 10_000);

httpServer.listen(port, host, () => {
  console.log(`Game authority server listening on ws://${host}:${port}`);
  console.log(`Health check available at http://127.0.0.1:${port}/health`);
});

function handleClientMessage(client: Client, message: ClientMessage) {
  if (message.type === 'restart') {
    restartMatch();
    broadcastSnapshots();
    return;
  }

  if (!client.playerId) return;
  if (message.sequence <= client.lastSequence) return;
  client.lastSequence = message.sequence;
  const sanitized = sanitizeInput(message.input);
  // Accumulate one-shot fields across messages arriving between ticks (clients can send
  // faster than the tick consumes); consumeOneShotInputs resets them each tick.
  client.input = {
    ...sanitized,
    look: client.input.look + sanitized.look,
    weapon: sanitized.weapon ?? client.input.weapon,
  };
  client.lastInputAt = performance.now();
}

function restartMatch() {
  state = createGameState(mission);
  for (const client of clients.values()) {
    client.input = createNeutralInput();
    client.lastInputAt = 0;
  }
}

function collectInputs(now: number): Inputs {
  return Object.fromEntries(
    playerIds.map((id) => {
      const client = [...clients.values()].find((item) => item.playerId === id);
      if (!client) return [id, createNeutralInput()];
      client.lastProcessedSequence = client.lastSequence;
      if (now - client.lastInputAt > inputTimeoutMs) return [id, createNeutralInput()];
      return [id, client.input];
    }),
  ) as Inputs;
}

function consumeOneShotInputs() {
  for (const client of clients.values()) {
    client.input = {
      ...client.input,
      look: 0,
      weapon: null,
      restart: false,
    };
  }
}

function claimPlayerSlot(resumeToken: string | null): PlayerId | null {
  const now = Date.now();
  for (const [token, reservation] of reservedSlots) {
    if (reservation.expires < now) reservedSlots.delete(token);
  }

  const occupied = new Set([...clients.values()].map((client) => client.playerId).filter(Boolean));

  if (resumeToken) {
    const reservation = reservedSlots.get(resumeToken);
    if (reservation && !occupied.has(reservation.playerId)) {
      reservedSlots.delete(resumeToken);
      return reservation.playerId;
    }
  }

  const reserved = new Set([...reservedSlots.values()].map((item) => item.playerId));
  return (
    playerIds.find((id) => !occupied.has(id) && !reserved.has(id))
    ?? playerIds.find((id) => !occupied.has(id))
    ?? null
  );
}

function connectedPlayers(): PlayerId[] {
  return [...clients.values()]
    .map((client) => client.playerId)
    .filter((id): id is PlayerId => id !== null);
}

function connectedPlayerInfo(): ConnectedPlayer[] {
  const connected = new Set(connectedPlayers());
  return playerIds.map((id) => ({
    id,
    connected: connected.has(id),
    label: state.players[id].name,
  }));
}

function sendSnapshot(client: Client) {
  send(client.socket, {
    type: 'snapshot',
    playerId: client.playerId,
    connectedPlayers: connectedPlayerInfo(),
    serverTime: Date.now(),
    lastProcessedInput: client.lastProcessedSequence,
    state,
  });
}

function broadcastSnapshots() {
  for (const client of clients.values()) sendSnapshot(client);
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function resumeTokenFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const token = new URL(url, 'http://localhost').searchParams.get('token');
    return token && token.length <= 64 ? token : null;
  } catch {
    return null;
  }
}

function decodeClientMessage(data: WebSocket.RawData): ClientMessage | null {
  try {
    const raw = JSON.parse(data.toString()) as ClientMessage;
    if (raw.type === 'restart') return raw;
    if (raw.type === 'input') return {
      type: 'input',
      sequence: Number(raw.sequence) || 0,
      input: sanitizeInput(raw.input),
    };
  } catch {
    return null;
  }
  return null;
}

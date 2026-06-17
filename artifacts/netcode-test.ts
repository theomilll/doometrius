// Headless netcode verification: two WS clients against the live dev server.
// Run: npx tsx artifacts/netcode-test.ts
import WebSocket from 'ws';

const URL = process.env.TEST_WS_URL ?? 'ws://127.0.0.1:8787';

type Snapshot = {
  type: string;
  playerId: string | null;
  lastProcessedInput: number;
  connectedPlayers: Array<{ id: string; connected: boolean }>;
  state: {
    mode: string;
    time: number;
    players: Record<string, { pos: { x: number; y: number }; angle: number; weapon: string }>;
  };
};

type Welcome = { type: 'welcome'; playerId: string | null; resumeToken: string };

class TestClient {
  ws!: WebSocket;
  playerId: string | null = null;
  resumeToken = '';
  lastSnapshot: Snapshot | null = null;
  snapshotCount = 0;
  bytes = 0;
  seq = 0;

  async connect(token?: string) {
    this.ws = new WebSocket(token ? `${URL}/?token=${token}` : URL);
    this.ws.on('message', (data) => {
      this.bytes += data.toString().length;
      const message = JSON.parse(data.toString());
      if (message.type === 'welcome') {
        const welcome = message as Welcome;
        this.playerId = welcome.playerId;
        this.resumeToken = welcome.resumeToken;
      } else if (message.type === 'snapshot') {
        this.lastSnapshot = message as Snapshot;
        this.snapshotCount += 1;
        this.playerId = message.playerId;
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    await waitFor(() => this.playerId !== null || this.resumeToken !== '', 'welcome');
  }

  sendInput(partial: Record<string, unknown>) {
    this.seq += 1;
    this.ws.send(JSON.stringify({
      type: 'input',
      sequence: this.seq,
      input: {
        forward: 0, strafe: 0, turn: 0, look: 0,
        shoot: false, reload: false, sprint: false, weapon: null, restart: false,
        ...partial,
      },
    }));
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(test: () => boolean, label: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await sleep(20);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const a = new TestClient();
  const b = new TestClient();
  await a.connect();
  await b.connect();
  check('slot assignment', new Set([a.playerId, b.playerId]).size === 2 && a.playerId !== null && b.playerId !== null, `${a.playerId}/${b.playerId}`);

  // restart to a clean briefing state in case server was mid-game
  a.ws.send(JSON.stringify({ type: 'restart' }));
  await waitFor(() => a.lastSnapshot?.state.mode === 'briefing', 'briefing mode');

  // both connected players visible
  await waitFor(() => (a.lastSnapshot?.connectedPlayers.filter((p) => p.connected).length ?? 0) === 2, 'both connected');
  check('both players reported connected', true);

  // start the game: either player firing starts it (B fires)
  const fireTimer = setInterval(() => b.sendInput({ shoot: true }), 16);
  await waitFor(() => a.lastSnapshot?.state.mode === 'playing', 'playing mode');
  clearInterval(fireTimer);
  check('any player can start the mission', true);

  // SIMULTANEITY: both hold forward at the same time; both positions must change.
  const posA0 = { ...a.lastSnapshot!.state.players[a.playerId!].pos };
  const posB0 = { ...a.lastSnapshot!.state.players[b.playerId!].pos };
  const moveTimer = setInterval(() => {
    a.sendInput({ forward: 1 });
    b.sendInput({ forward: 1 });
  }, 16);
  await sleep(700);
  clearInterval(moveTimer);
  const posA1 = a.lastSnapshot!.state.players[a.playerId!].pos;
  const posB1 = a.lastSnapshot!.state.players[b.playerId!].pos;
  const movedA = Math.hypot(posA1.x - posA0.x, posA1.y - posA0.y);
  const movedB = Math.hypot(posB1.x - posB0.x, posB1.y - posB0.y);
  check('co-op simultaneity: P1 moved', movedA > 0.5, movedA.toFixed(2));
  check('co-op simultaneity: P2 moved', movedB > 0.5, movedB.toFixed(2));

  // input ack flows back
  check('lastProcessedInput acked', (a.lastSnapshot?.lastProcessedInput ?? -1) > 0, `${a.lastSnapshot?.lastProcessedInput}`);

  // weapon switch round-trips
  b.sendInput({ weapon: 'ribShotgun' });
  await waitFor(() => a.lastSnapshot?.state.players[b.playerId!].weapon === 'ribShotgun', 'weapon switch');
  check('weapon switch (key 2) applies', true);

  // snapshot rate ~20Hz
  const countStart = a.snapshotCount;
  const bytesStart = a.bytes;
  await sleep(2000);
  const rate = (a.snapshotCount - countStart) / 2;
  const bytesPerSecond = (a.bytes - bytesStart) / 2;
  check('snapshot rate ~20Hz', rate >= 16 && rate <= 25, `${rate.toFixed(1)}/s`);
  check('bandwidth < 120KB/s raw JSON', bytesPerSecond < 120_000, `${(bytesPerSecond / 1000).toFixed(1)}KB/s`);

  // RESUME: drop B, reconnect with token, must get the same slot back.
  const tokenB = b.resumeToken;
  const slotB = b.playerId;
  b.close();
  await sleep(300);
  const b2 = new TestClient();
  await b2.connect(tokenB);
  check('reconnect re-claims same slot', b2.playerId === slotB, `${b2.playerId} == ${slotB}`);

  // restart works from message
  b2.ws.send(JSON.stringify({ type: 'restart' }));
  await waitFor(() => a.lastSnapshot?.state.mode === 'briefing' && a.lastSnapshot.state.time < 1, 'restart');
  check('restart resets match for everyone', true);

  a.close();
  b2.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});

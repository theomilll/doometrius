import { normalizeAngle, type Vec2 } from '../game/core/math';
import type { GameState, Mission, PlayerId } from '../game/core/types';
import type { PlayerInput } from '../game/input';
import {
  applyPlayerMovement,
  smoothPlayerCamera,
  type CameraState,
  type MoveState,
} from '../game/simulation';

type PendingInput = { sequence: number; input: PlayerInput; dt: number };

const SNAP_DISTANCE = 0.75;
const ERROR_DECAY = 12;

// Client-side prediction of the local player's movement. The server stays authoritative;
// we re-run the shared movement code for inputs the server hasn't processed yet, and fold
// any divergence into a decaying error offset so corrections never visibly snap.
export class LocalPredictor {
  private pending: PendingInput[] = [];
  private predicted: MoveState | null = null;
  private errorPos: Vec2 = { x: 0, y: 0 };
  private errorAngle = 0;

  constructor(private readonly mission: Mission) {}

  reset() {
    this.pending = [];
    this.predicted = null;
    this.errorPos = { x: 0, y: 0 };
    this.errorAngle = 0;
  }

  get pendingCount() {
    return this.pending.length;
  }

  applyLocal(state: GameState, playerId: PlayerId, sequence: number, input: PlayerInput, dt: number) {
    const player = state.players[playerId];
    if (state.mode !== 'playing' || !player?.alive) {
      this.reset();
      return;
    }
    if (!this.predicted) {
      this.predicted = { pos: { ...player.pos }, angle: player.angle };
    }
    this.pending.push({ sequence, input, dt });
    this.predicted = applyPlayerMovement(this.mission, state.props, this.predicted, input, dt);
  }

  reconcile(state: GameState, playerId: PlayerId, lastProcessedInput: number) {
    const player = state.players[playerId];
    if (state.mode !== 'playing' || !player?.alive) {
      this.reset();
      return;
    }
    this.pending = this.pending.filter((item) => item.sequence > lastProcessedInput);

    let corrected: MoveState = { pos: { ...player.pos }, angle: player.angle };
    for (const item of this.pending) {
      corrected = applyPlayerMovement(this.mission, state.props, corrected, item.input, item.dt);
    }

    if (this.predicted) {
      const renderX = this.predicted.pos.x + this.errorPos.x;
      const renderY = this.predicted.pos.y + this.errorPos.y;
      const renderAngle = this.predicted.angle + this.errorAngle;
      this.errorPos = { x: renderX - corrected.pos.x, y: renderY - corrected.pos.y };
      this.errorAngle = normalizeAngle(renderAngle - corrected.angle);
      if (Math.hypot(this.errorPos.x, this.errorPos.y) > SNAP_DISTANCE) {
        this.errorPos = { x: 0, y: 0 };
        this.errorAngle = 0;
      }
    }
    this.predicted = corrected;
  }

  renderPose(dt: number): MoveState | null {
    if (!this.predicted) return null;
    const decay = Math.exp(-ERROR_DECAY * dt);
    this.errorPos = { x: this.errorPos.x * decay, y: this.errorPos.y * decay };
    this.errorAngle *= decay;
    return {
      pos: { x: this.predicted.pos.x + this.errorPos.x, y: this.predicted.pos.y + this.errorPos.y },
      angle: normalizeAngle(this.predicted.angle + this.errorAngle),
    };
  }

  predictedPos(): Vec2 | null {
    return this.predicted ? { ...this.predicted.pos } : null;
  }

  // Raw predicted pose without advancing error decay (renderPose does that per frame).
  currentPose(): MoveState | null {
    return this.predicted ? { pos: { ...this.predicted.pos }, angle: this.predicted.angle } : null;
  }
}

// View smoothing (camera lag, head bob) for the local player, run per render frame
// against the predicted pose. The server's view fields are ignored for the local player.
export class LocalView {
  private camera: CameraState | null = null;

  reset() {
    this.camera = null;
  }

  update(pose: MoveState, moving: boolean, sprinting: boolean, dt: number): CameraState {
    if (!this.camera) {
      this.camera = {
        pos: { ...pose.pos },
        angle: pose.angle,
        z: 0,
        viewPos: { ...pose.pos },
        viewAngle: pose.angle,
        viewZ: 0,
        moveBlend: 0,
        bobPhase: 0,
      };
    }
    this.camera.pos = pose.pos;
    this.camera.angle = pose.angle;
    smoothPlayerCamera(this.camera, moving, sprinting, dt);
    return this.camera;
  }
}

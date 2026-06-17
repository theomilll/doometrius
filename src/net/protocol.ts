import type { PlayerInput } from '../game/input';
import type { GameState, PlayerId, WeaponId } from '../game/core/types';

export const DEFAULT_GAME_SERVER_PORT = 8787;

export type ConnectedPlayer = {
  id: PlayerId;
  connected: boolean;
  label: string;
};

export type ClientMessage =
  | {
      type: 'input';
      sequence: number;
      input: PlayerInput;
    }
  | {
      type: 'restart';
    };

export type ServerMessage =
  | {
      type: 'welcome';
      clientId: string;
      playerId: PlayerId | null;
      resumeToken: string;
      tickRate: number;
      snapshotRate: number;
    }
  | {
      type: 'snapshot';
      playerId: PlayerId | null;
      connectedPlayers: ConnectedPlayer[];
      serverTime: number;
      lastProcessedInput: number;
      state: GameState;
    }
  | {
      type: 'error';
      message: string;
    };

// Shared by server (inbound validation) and client (pre-prediction + pre-send), so the
// input the client predicts with is exactly the input the server will apply.
export function sanitizeInput(input: PlayerInput): PlayerInput {
  return {
    forward: clampAxis(input?.forward),
    strafe: clampAxis(input?.strafe),
    turn: clampAxis(input?.turn),
    look: clampNumber(input?.look, -0.35, 0.35),
    shoot: Boolean(input?.shoot),
    reload: Boolean(input?.reload),
    sprint: Boolean(input?.sprint),
    weapon: sanitizeWeapon(input?.weapon),
    restart: Boolean(input?.restart),
  };
}

function sanitizeWeapon(value: unknown): WeaponId | null {
  return value === 'stakePistol' || value === 'ribShotgun' ? value : null;
}

function clampAxis(value: unknown) {
  return clampNumber(value, -1, 1);
}

function clampNumber(value: unknown, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(min, Math.min(max, numeric));
}

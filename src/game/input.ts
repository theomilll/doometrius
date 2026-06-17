import type { WeaponId } from './core/types';

export type PlayerInput = {
  forward: number;
  strafe: number;
  turn: number;
  look: number;
  shoot: boolean;
  reload: boolean;
  sprint: boolean;
  weapon: WeaponId | null;
  restart: boolean;
};

type KeyMap = {
  forward: readonly string[];
  back: readonly string[];
  left: readonly string[];
  right: readonly string[];
  turnLeft: readonly string[];
  turnRight: readonly string[];
  shoot: readonly string[];
  reload: readonly string[];
  sprint: readonly string[];
  weaponPistol: readonly string[];
  weaponShotgun: readonly string[];
};

const map: KeyMap = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  turnLeft: ['ArrowLeft', 'KeyQ'],
  turnRight: ['ArrowRight', 'KeyE'],
  shoot: ['KeyF'],
  reload: ['KeyR'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  weaponPistol: ['Digit1'],
  weaponShotgun: ['Digit2'],
};

const capturedCodes = new Set<string>([
  'KeyR',
  ...map.forward,
  ...map.back,
  ...map.left,
  ...map.right,
  ...map.turnLeft,
  ...map.turnRight,
  ...map.shoot,
  ...map.reload,
  ...map.sprint,
  ...map.weaponPistol,
  ...map.weaponShotgun,
]);

export class InputManager {
  private pressed = new Set<string>();
  private pointerButtons = new Set<number>();
  private pendingMouseX = 0;
  private pendingPrimaryClick = false;
  private pendingWeapon: WeaponId | null = null;
  private knownWeapon: WeaponId = 'stakePistol';
  private mouseLookArmed = false;
  private fallbackMouseX: number | null = null;
  private readonly mouseSensitivity = 0.0024;

  bind(target: Window) {
    const down = (event: KeyboardEvent) => {
      if (this.shouldCapture(event.code)) event.preventDefault();
      if (map.weaponPistol.includes(event.code)) this.pendingWeapon = 'stakePistol';
      if (map.weaponShotgun.includes(event.code)) this.pendingWeapon = 'ribShotgun';
      if (event.code === 'Escape') this.releaseMouseLook();
      this.pressed.add(event.code);
    };
    const up = (event: KeyboardEvent) => {
      if (this.shouldCapture(event.code)) event.preventDefault();
      this.pressed.delete(event.code);
    };
    const mouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement) {
        this.pendingMouseX += event.movementX;
        this.fallbackMouseX = event.clientX;
        return;
      }
      if (this.mouseLookArmed) {
        if (this.fallbackMouseX !== null) {
          this.pendingMouseX += event.clientX - this.fallbackMouseX;
        }
        this.fallbackMouseX = event.clientX;
      }
    };
    const mouseDown = (event: MouseEvent) => {
      if (document.pointerLockElement || this.mouseLookArmed) {
        event.preventDefault();
        this.pointerButtons.add(event.button);
      }
    };
    const mouseUp = (event: MouseEvent) => {
      this.pointerButtons.delete(event.button);
    };
    const contextMenu = (event: MouseEvent) => {
      if (document.pointerLockElement || this.mouseLookArmed) event.preventDefault();
    };
    const wheel = (event: WheelEvent) => {
      if (!document.pointerLockElement && !this.mouseLookArmed) return;
      event.preventDefault();
      this.queueWeaponToggle();
    };
    target.addEventListener('keydown', down, { passive: false });
    target.addEventListener('keyup', up, { passive: false });
    target.addEventListener('mousemove', mouseMove, { passive: true });
    target.addEventListener('mousedown', mouseDown, { passive: false });
    target.addEventListener('mouseup', mouseUp);
    target.addEventListener('contextmenu', contextMenu, { passive: false });
    target.addEventListener('wheel', wheel, { passive: false });
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('mousemove', mouseMove);
      target.removeEventListener('mousedown', mouseDown);
      target.removeEventListener('mouseup', mouseUp);
      target.removeEventListener('contextmenu', contextMenu);
      target.removeEventListener('wheel', wheel);
    };
  }

  read(): PlayerInput {
    const look = this.pendingMouseX * this.mouseSensitivity;
    this.pendingMouseX = 0;
    const clicked = this.pendingPrimaryClick;
    const weapon = this.pendingWeapon;
    this.pendingPrimaryClick = false;
    this.pendingWeapon = null;
    return {
      forward: Number(this.anyPressed(map.forward)) - Number(this.anyPressed(map.back)),
      strafe: Number(this.anyPressed(map.right)) - Number(this.anyPressed(map.left)),
      turn: Number(this.anyPressed(map.turnRight)) - Number(this.anyPressed(map.turnLeft)),
      look,
      shoot: clicked || this.anyPressed(map.shoot) || this.pointerButtons.has(0),
      reload: this.anyPressed(map.reload),
      sprint: this.anyPressed(map.sprint),
      weapon,
      restart: this.pressed.has('KeyR'),
    };
  }

  private shouldCapture(code: string) {
    return capturedCodes.has(code);
  }

  primePrimaryClick() {
    this.pendingPrimaryClick = true;
  }

  armMouseLook(clientX: number) {
    this.mouseLookArmed = true;
    this.fallbackMouseX = clientX;
  }

  queueWeaponToggle() {
    const base = this.pendingWeapon ?? this.knownWeapon;
    this.pendingWeapon = base === 'ribShotgun' ? 'stakePistol' : 'ribShotgun';
  }

  setKnownWeapon(weapon: WeaponId) {
    this.knownWeapon = weapon;
  }

  private releaseMouseLook() {
    this.mouseLookArmed = false;
    this.fallbackMouseX = null;
    this.pointerButtons.clear();
  }

  private anyPressed(codes: readonly string[]) {
    return codes.some((code) => this.pressed.has(code));
  }
}

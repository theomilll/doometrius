export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function normalizeAngle(angle: number) {
  let value = angle % TAU;
  if (value < -Math.PI) value += TAU;
  if (value > Math.PI) value -= TAU;
  return value;
}

export function distance(a: Vec2, b: Vec2) {
  const dx = a.x - b.x;
  const y = a.y - b.y;
  return Math.hypot(dx, y);
}

export function angleTo(from: Vec2, to: Vec2) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function pointInCircle(point: Vec2, center: Vec2, radius: number) {
  return distance(point, center) <= radius;
}

export function hashNoise(x: number, y: number, seed = 1) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export type Vec2 = {
  x: number;
  y: number;
};

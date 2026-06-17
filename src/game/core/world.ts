import type { Mission, PropState } from './types';
import type { Vec2 } from './math';

export function getTile(mission: Mission, x: number, y: number) {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  if (gx < 0 || gy < 0 || gx >= mission.width || gy >= mission.height) {
    return mission.tileLegend['#'];
  }
  return mission.tileLegend[mission.grid[gy]?.[gx] ?? '#'] ?? mission.tileLegend['.'];
}

export function isSolidAt(mission: Mission, props: PropState[], x: number, y: number, radius = 0.18, z = 0) {
  const probes = [
    { x, y },
    { x: x + radius, y },
    { x: x - radius, y },
    { x, y: y + radius },
    { x, y: y - radius },
  ];

  if (probes.some((probe) => getTile(mission, probe.x, probe.y).solid)) {
    return true;
  }

  return props.some((prop) => {
    if (!prop.blocking || prop.health === 0) return false;
    if (prop.height !== undefined && z > prop.height + 0.05) return false;
    return Math.hypot(prop.pos.x - x, prop.pos.y - y) < prop.radius + radius;
  });
}

export function moveWithCollision(
  mission: Mission,
  props: PropState[],
  pos: Vec2,
  delta: Vec2,
  radius = 0.2,
  z = 0,
) {
  let nextX = pos.x + delta.x;
  let nextY = pos.y;
  if (isSolidAt(mission, props, nextX, nextY, radius, z)) {
    nextX = pos.x;
  }
  if (!isSolidAt(mission, props, nextX, pos.y + delta.y, radius, z)) {
    nextY = pos.y + delta.y;
  }
  return { x: nextX, y: nextY };
}

export function rectContains(zone: { x: number; y: number; w: number; h: number }, point: Vec2) {
  return point.x >= zone.x && point.y >= zone.y && point.x <= zone.x + zone.w && point.y <= zone.y + zone.h;
}

export function hasLineOfSight(mission: Mission, props: PropState[], from: Vec2, to: Vec2) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(4, Math.ceil(Math.hypot(dx, dy) * 8));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (isSolidAt(mission, props, from.x + dx * t, from.y + dy * t, 0.05)) return false;
  }
  return true;
}

import { angleTo, clamp, distance, normalizeAngle, type Vec2 } from '../core/math';
import { playerIds } from '../core/types';
import type {
  BossState,
  EnemyState,
  GameState,
  Mission,
  PickupState,
  PlayerId,
  PlayerState,
  ProjectileState,
  PropState,
} from '../core/types';
import { getTile } from '../core/world';
import { assetManifest, type LoadedAssets } from '../assets/manifest';
import { weapons } from '../weapons';
import type { FxState } from '../client/fx';

type Viewport = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type RayHit = {
  distance: number;
  texture: string;
  shade: number;
  offset: number;
};

type TextureSample = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type PlaneBuffer = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;
  width: number;
  height: number;
};

type SpriteDraw = {
  pos: Vec2;
  image: HTMLImageElement | HTMLCanvasElement;
  scale: number;
  kind: 'enemy' | 'boss' | 'pickup' | 'prop' | 'projectile' | 'impact' | 'player';
  healthRatio?: number;
  alpha?: number;
  stridePhase?: number;
  flash?: boolean;
  label?: string;
  lift01?: number;
};

const FOV = Math.PI / 3;
const MAX_RAY_DISTANCE = 24;
const HORIZON_RATIO = 0.5;
const WALL_PROJECTION_SCALE = 0.82;
const CAMERA_HEIGHT = 0.54;
const PLANE_MAX_DISTANCE = 28;

const textureSampleCache = new WeakMap<HTMLImageElement, TextureSample>();
let planeBuffer: PlaneBuffer | null = null;
let sharedZBuffer = new Float32Array(0);
export function renderGame(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  state: GameState,
  mission: Mission,
  assets: LoadedAssets,
  viewpointId: PlayerId = 'p1',
  fx?: FxState,
) {
  ctx.clearRect(0, 0, size.width, size.height);
  const viewpoint = state.players[viewpointId] ?? state.players.p1;
  // Classic DOOM split: the 3D view occupies the top region, the status bar is its own
  // strip below it — the weapon view-model is never covered by HUD.
  const barHeight = clamp(size.height * 0.135, 88, 116);
  drawViewport(ctx, { x: 0, y: 0, w: size.width, h: size.height - barHeight }, viewpoint, viewpointId, state, mission, assets, fx);
  drawDoomStatusBar(ctx, { x: 0, y: size.height - barHeight, w: size.width, h: barHeight }, viewpoint, state, assets, fx);

  if (state.mode === 'briefing') drawBriefing(ctx, size, assets);
  if (state.mode === 'won' || state.mode === 'lost') drawEndState(ctx, size, state);
}

function drawViewport(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  playerId: PlayerId,
  state: GameState,
  mission: Mission,
  assets: LoadedAssets,
  fx?: FxState,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.w, viewport.h);
  ctx.clip();

  const shakeX = player.alive ? (Math.sin(state.time * 47) * player.shake * 7) : 0;
  const shakeY = player.alive ? (Math.cos(state.time * 53) * player.shake * 5) : 0;
  const bobY = Math.sin(player.bobPhase) * player.moveBlend * viewport.h * 0.006;
  const landingDrop = player.landingTimer > 0 ? Math.sin((player.landingTimer / 0.16) * Math.PI) * viewport.h * 0.01 : 0;
  const camera = { x: viewport.x + shakeX, y: viewport.y + shakeY + bobY + landingDrop, w: viewport.w, h: viewport.h };
  const cameraPlayer: PlayerState = {
    ...player,
    pos: player.viewPos,
    angle: player.viewAngle,
    z: player.viewZ,
  };

  drawSkyFloor(ctx, camera, cameraPlayer, state, mission, assets);
  const zBuffer = castWalls(ctx, camera, cameraPlayer, mission, assets);
  drawSprites(ctx, camera, cameraPlayer, playerId, state, assets, zBuffer);
  const muzzleAnchor = drawWeapon(ctx, camera, player, state, assets);
  if (fx && muzzleAnchor && player.alive) drawTracers(ctx, camera, cameraPlayer, fx.tracers, muzzleAnchor);
  drawViewportHud(ctx, camera, player, state, assets, fx);
  ctx.restore();
}

// Brief screen-space streak from the gun's muzzle to where the shot actually landed, so
// hitscan shots read as coming from the weapon instead of the middle of the screen.
function drawTracers(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  tracers: Array<{ to: Vec2; height: number; t: number }>,
  muzzle: { x: number; y: number },
) {
  if (!tracers.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const tracer of tracers) {
    const dx = tracer.to.x - player.pos.x;
    const dy = tracer.to.y - player.pos.y;
    const forward = Math.cos(player.angle) * dx + Math.sin(player.angle) * dy;
    const lateral = -Math.sin(player.angle) * dx + Math.cos(player.angle) * dy;
    if (forward < 0.15) continue;
    const angle = Math.atan2(lateral, forward);
    if (Math.abs(angle) > FOV * 0.6) continue;
    const screenX = viewport.x + (0.5 + Math.tan(angle) / Math.tan(FOV / 2) * 0.5) * viewport.w;
    const projectedUnit = viewport.h / Math.max(0.22, forward * WALL_PROJECTION_SCALE);
    const floorY = viewport.y + viewport.h * HORIZON_RATIO + projectedUnit / 2;
    const screenY = floorY - projectedUnit * tracer.height;
    const alpha = clamp(tracer.t / 0.08, 0, 1) * 0.55;
    ctx.strokeStyle = `rgba(255, 214, 140, ${alpha * 0.35})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(muzzle.x, muzzle.y);
    ctx.lineTo(screenX, screenY);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 238, 198, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(muzzle.x, muzzle.y);
    ctx.lineTo(screenX, screenY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSkyFloor(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  state: GameState,
  mission: Mission,
  assets: LoadedAssets,
) {
  const ceiling = assets.images.get(assetManifest.textures.ceiling);
  const floor = assets.images.get(assetManifest.textures.floor);
  const horizonY = viewport.y + viewport.h * HORIZON_RATIO;

  if (floor && ceiling) {
    drawPerspectivePlanes(ctx, viewport, player, state, mission, floor, ceiling);
  } else {
    drawFallbackPlanes(ctx, viewport, horizonY, floor, ceiling);
  }

  ctx.fillStyle = 'rgba(255, 178, 74, 0.12)';
  ctx.fillRect(viewport.x, horizonY - 1, viewport.w, 2);

  const depthFog = ctx.createLinearGradient(0, viewport.y, 0, viewport.y + viewport.h);
  depthFog.addColorStop(0, 'rgba(0, 0, 0, 0.38)');
  depthFog.addColorStop(0.48, 'rgba(47, 13, 13, 0.05)');
  depthFog.addColorStop(1, 'rgba(0, 0, 0, 0.46)');
  ctx.fillStyle = depthFog;
  ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);

  const vignette = ctx.createRadialGradient(
    viewport.x + viewport.w * 0.5,
    horizonY,
    viewport.h * 0.16,
    viewport.x + viewport.w * 0.5,
    horizonY,
    viewport.h * 0.9,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
  ctx.fillStyle = vignette;
  ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
}

function drawPerspectivePlanes(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  state: GameState,
  mission: Mission,
  floorImage: HTMLImageElement,
  ceilingImage: HTMLImageElement,
) {
  const floor = getTextureSample(floorImage);
  const ceiling = getTextureSample(ceilingImage);
  if (!floor || !ceiling) {
    drawFallbackPlanes(ctx, viewport, viewport.y + viewport.h * HORIZON_RATIO, floorImage, ceilingImage);
    return;
  }

  const buffer = getPlaneBuffer(viewport);
  const data = buffer.imageData.data;
  const width = buffer.width;
  const height = buffer.height;
  const horizon = height * HORIZON_RATIO;
  const dirX = Math.cos(player.angle);
  const dirY = Math.sin(player.angle);
  const planeLength = Math.tan(FOV / 2);
  const planeX = -dirY * planeLength;
  const planeY = dirX * planeLength;
  const rayLeftX = dirX - planeX;
  const rayLeftY = dirY - planeY;
  const rayRightX = dirX + planeX;
  const rayRightY = dirY + planeY;
  const rayStepX = (rayRightX - rayLeftX) / width;
  const rayStepY = (rayRightY - rayLeftY) / width;

  for (let y = 0; y < height; y += 1) {
    const rowDelta = y - horizon;
    const isFloor = rowDelta >= 0;
    const distanceFromHorizon = Math.max(1, Math.abs(rowDelta));
    const eyeHeight = CAMERA_HEIGHT + player.viewZ * 0.8;
    const rowDistance = clamp(
      (height * eyeHeight) / (distanceFromHorizon * WALL_PROJECTION_SCALE),
      0.28,
      PLANE_MAX_DISTANCE,
    );
    let worldX = player.pos.x + rowDistance * rayLeftX;
    let worldY = player.pos.y + rowDistance * rayLeftY;
    const stepX = rowDistance * rayStepX;
    const stepY = rowDistance * rayStepY;

    for (let x = 0; x < width; x += 1) {
      const source = isFloor ? floor : ceiling;
      const floorWorldX = worldX;
      const floorWorldY = worldY;
      const sampleX = isFloor ? floorWorldX : floorWorldX * 0.82 + 0.19;
      const sampleY = isFloor ? floorWorldY : floorWorldY * 0.82 - 0.11;
      const tx = wrappedTextureCoord(sampleX, source.width);
      const ty = wrappedTextureCoord(sampleY, source.height);
      const sourceIndex = (ty * source.width + tx) * 4;
      const tile = getTile(mission, floorWorldX, floorWorldY);
      const tileHeight = tile.height ?? 0;
      const uvX = positiveFract(floorWorldX);
      const uvY = positiveFract(floorWorldY);
      const grout = uvX < 0.026 || uvY < 0.026 || uvX > 0.974 || uvY > 0.974;
      const platformEdge = tileHeight > 0 && (uvX < 0.055 || uvY < 0.055 || uvX > 0.945 || uvY > 0.945);
      const roofRib = !isFloor && (Math.abs(positiveFract(floorWorldX * 0.5) - 0.5) < 0.022 || Math.abs(positiveFract(floorWorldY * 0.5) - 0.5) < 0.022);
      const hazardPulse = tile.hazard ? 0.34 + Math.max(0, Math.sin(state.time * 5.2 + floorWorldX)) * 0.14 : 0;
      const sideDarken = 1 - Math.abs(x / width - 0.5) * 0.16;
      const baseShade = isFloor
        ? 1.08 - rowDistance * 0.047
        : 0.88 - rowDistance * 0.033;
      let shade = clamp(baseShade * sideDarken, isFloor ? 0.2 : 0.16, isFloor ? 1 : 0.82);
      if (grout) shade *= isFloor ? 0.58 : 0.7;
      if (platformEdge) shade *= 0.42;
      if (roofRib) shade *= 0.56;
      if (tile.solid) shade *= 0.54;

      let r = source.data[sourceIndex] * shade;
      let g = source.data[sourceIndex + 1] * shade;
      let b = source.data[sourceIndex + 2] * shade;

      if (tile.texture === 'boss') {
        r = r * 1.15 + 18;
        g = g * 0.92 + 9;
        b = b * 0.72;
      } else if (tile.texture === 'meat' || hazardPulse > 0) {
        r = r * (1 + hazardPulse) + 30 * hazardPulse;
        g = g * (1 - hazardPulse * 0.42);
        b = b * (1 - hazardPulse * 0.5);
      }
      if (isFloor && tileHeight > 0) {
        r = r * (1 + tileHeight * 0.26) + 20 * tileHeight;
        g = g * (1 + tileHeight * 0.14) + 10 * tileHeight;
        b *= 0.92;
      }
      if (!isFloor) {
        r *= 0.72;
        g *= 0.76;
        b *= 0.86;
        if (roofRib) {
          r += 5;
          g += 4;
          b += 8;
        }
      }

      const fog = clamp((rowDistance - 5.5) / 18, 0, 0.76);
      const fogR = isFloor ? 10 : 5;
      const fogG = isFloor ? 5 : 6;
      const fogB = isFloor ? 6 : 12;
      const dest = (y * width + x) * 4;
      data[dest] = r * (1 - fog) + fogR * fog;
      data[dest + 1] = g * (1 - fog) + fogG * fog;
      data[dest + 2] = b * (1 - fog) + fogB * fog;
      data[dest + 3] = 255;

      worldX += stepX;
      worldY += stepY;
    }
  }

  buffer.ctx.putImageData(buffer.imageData, 0, 0);
  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buffer.canvas, viewport.x, viewport.y, viewport.w, viewport.h);
  ctx.imageSmoothingEnabled = previousSmoothing;
}

function drawFallbackPlanes(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  horizonY: number,
  floor?: HTMLImageElement,
  ceiling?: HTMLImageElement,
) {
  const topGradient = ctx.createLinearGradient(0, viewport.y, 0, horizonY);
  topGradient.addColorStop(0, '#06070c');
  topGradient.addColorStop(0.58, '#151018');
  topGradient.addColorStop(1, '#2d1d1f');
  ctx.fillStyle = topGradient;
  ctx.fillRect(viewport.x, viewport.y, viewport.w, horizonY - viewport.y);
  if (ceiling) {
    const pattern = ctx.createPattern(ceiling, 'repeat');
    if (pattern) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = pattern;
      ctx.fillRect(viewport.x, viewport.y, viewport.w, horizonY - viewport.y);
      ctx.globalAlpha = 1;
    }
  }

  const floorGradient = ctx.createLinearGradient(0, horizonY, 0, viewport.y + viewport.h);
  floorGradient.addColorStop(0, '#3a2821');
  floorGradient.addColorStop(0.52, '#1d1513');
  floorGradient.addColorStop(1, '#080709');
  ctx.fillStyle = floorGradient;
  ctx.fillRect(viewport.x, horizonY, viewport.w, viewport.y + viewport.h - horizonY);
  if (floor) {
    const pattern = ctx.createPattern(floor, 'repeat');
    if (pattern) {
      ctx.globalAlpha = 0.17;
      ctx.fillStyle = pattern;
      ctx.fillRect(viewport.x, horizonY, viewport.w, viewport.y + viewport.h - horizonY);
      ctx.globalAlpha = 1;
    }
  }
}

function getPlaneBuffer(viewport: Viewport): PlaneBuffer {
  const area = viewport.w * viewport.h;
  const scale = area > 1_100_000 ? 0.5 : 0.55;
  const width = Math.floor(clamp(viewport.w * scale, 320, 1120));
  const height = Math.floor(clamp(viewport.h * scale, 220, 680));
  if (!planeBuffer || planeBuffer.width !== width || planeBuffer.height !== height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) throw new Error('Unable to create plane render buffer.');
    planeBuffer = {
      canvas,
      ctx: canvasCtx,
      imageData: canvasCtx.createImageData(width, height),
      width,
      height,
    };
  }
  return planeBuffer;
}

function getTextureSample(image: HTMLImageElement): TextureSample | undefined {
  const cached = textureSampleCache.get(image);
  if (cached) return cached;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  if (!canvasCtx) return undefined;
  canvasCtx.drawImage(image, 0, 0);
  const sample = {
    width,
    height,
    data: canvasCtx.getImageData(0, 0, width, height).data,
  };
  textureSampleCache.set(image, sample);
  return sample;
}

function wrappedTextureCoord(value: number, size: number) {
  return Math.floor(positiveFract(value) * size) % size;
}

function positiveFract(value: number) {
  return value - Math.floor(value);
}

function castWalls(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  mission: Mission,
  assets: LoadedAssets,
) {
  const width = Math.max(1, Math.floor(viewport.w));
  if (sharedZBuffer.length !== width) sharedZBuffer = new Float32Array(width);
  const zBuffer = sharedZBuffer;
  for (let x = 0; x < width; x += 1) {
    const cameraX = x / width;
    const angle = player.angle - FOV / 2 + cameraX * FOV;
    const hit = castRay(mission, player.pos, angle);
    const correctedDistance = hit.distance * Math.cos(angle - player.angle);
    zBuffer[x] = correctedDistance;
    const wallHeight = Math.min(viewport.h * 2.8, viewport.h / Math.max(0.08, correctedDistance * WALL_PROJECTION_SCALE));
    const y = viewport.y + viewport.h * HORIZON_RATIO - wallHeight / 2;
    const texture = assets.images.get(assetManifest.textures[hit.texture] ?? assetManifest.textures.bone);
    const shade = clamp(hit.shade / (1 + correctedDistance * 0.09), 0.24, 1);
    if (texture) {
      const texX = Math.floor(hit.offset * (texture.width - 1));
      ctx.globalAlpha = 1;
      ctx.drawImage(texture, texX, 0, 1, texture.height, viewport.x + x, y, 1.4, wallHeight);
      ctx.fillStyle = `rgba(0, 0, 0, ${clamp(1 - shade, 0, 0.76)})`;
      ctx.fillRect(viewport.x + x, y, 1.4, wallHeight);
      // Skip the subtle top highlight on small/distant columns where it is invisible anyway.
      if (wallHeight >= 24 && correctedDistance < 8) {
        ctx.fillStyle = `rgba(255, 216, 128, ${clamp(shade * 0.08, 0.015, 0.06)})`;
        ctx.fillRect(viewport.x + x, y, 1.4, Math.max(1, wallHeight * 0.08));
      }
    } else {
      ctx.fillStyle = `rgb(${Math.floor(130 * shade)}, ${Math.floor(90 * shade)}, ${Math.floor(80 * shade)})`;
      ctx.fillRect(viewport.x + x, y, 1.4, wallHeight);
    }
    if (correctedDistance > 7) {
      ctx.fillStyle = `rgba(18, 4, 8, ${clamp((correctedDistance - 7) / 10, 0, 0.72)})`;
      ctx.fillRect(viewport.x + x, y, 1.4, wallHeight);
    }
    if (y > viewport.y && wallHeight >= 24 && correctedDistance < 8) {
      ctx.fillStyle = 'rgba(255, 192, 94, 0.06)';
      ctx.fillRect(viewport.x + x, y - 1, 1.4, 1);
    }
  }
  return zBuffer;
}

function castRay(mission: Mission, origin: Vec2, angle: number): RayHit {
  const rayDirX = Math.cos(angle);
  const rayDirY = Math.sin(angle);
  let mapX = Math.floor(origin.x);
  let mapY = Math.floor(origin.y);
  const deltaDistX = Math.abs(1 / (rayDirX || 0.0001));
  const deltaDistY = Math.abs(1 / (rayDirY || 0.0001));
  const stepX = rayDirX < 0 ? -1 : 1;
  const stepY = rayDirY < 0 ? -1 : 1;
  let sideDistX = rayDirX < 0 ? (origin.x - mapX) * deltaDistX : (mapX + 1 - origin.x) * deltaDistX;
  let sideDistY = rayDirY < 0 ? (origin.y - mapY) * deltaDistY : (mapY + 1 - origin.y) * deltaDistY;
  let side = 0;
  let steps = 0;

  while (steps < 96) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1;
    }
    steps += 1;
    const tile = getTile(mission, mapX + 0.001, mapY + 0.001);
    if (tile.solid) {
      const distance = side === 0
        ? (mapX - origin.x + (1 - stepX) / 2) / (rayDirX || 0.0001)
        : (mapY - origin.y + (1 - stepY) / 2) / (rayDirY || 0.0001);
      const wallX = side === 0 ? origin.y + distance * rayDirY : origin.x + distance * rayDirX;
      return {
        distance: Math.min(MAX_RAY_DISTANCE, Math.abs(distance)),
        texture: wallTextureVariant(tile.texture, mapX, mapY),
        shade: side === 0 ? 0.92 : 0.72,
        offset: wallX - Math.floor(wallX),
      };
    }
  }

  return { distance: MAX_RAY_DISTANCE, texture: 'bone', shade: 0.35, offset: 0 };
}

function wallTextureVariant(texture: string, x: number, y: number) {
  if (texture !== 'bone') return texture;
  const hash = Math.abs((x * 73856093) ^ (y * 19349663));
  if (hash % 17 === 0) return 'door';
  if (hash % 7 === 0) return 'rust';
  return 'bone';
}

function drawSprites(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  playerId: PlayerId,
  state: GameState,
  assets: LoadedAssets,
  zBuffer: Float32Array,
) {
  const sprites: SpriteDraw[] = [];
  for (const prop of state.props) addPropSprite(sprites, prop, assets);
  for (const pickup of state.pickups) if (!pickup.taken) addPickupSprite(sprites, pickup, state.time, assets);
  for (const projectile of state.projectiles) addProjectileSprite(sprites, projectile, state.time, assets);
  for (const id of playerIds) if (id !== playerId && state.players[id].alive) addPlayerSprite(sprites, state.players[id], player, assets);
  for (const enemy of state.enemies) if (enemy.health > 0 || enemy.deathTimer < 0.8) addEnemySprite(sprites, enemy, player, state.time, assets);
  if (state.boss.active || state.boss.defeated) addBossSprite(sprites, state.boss, player, state.time, assets);
  for (const impact of state.impacts) {
    // The shooter's own muzzle puff is already drawn on the view model; the world copy
    // would float in mid-screen, so only remote viewers see it.
    if (impact.kind === 'muzzle' && impact.owner === playerId) continue;
    const frame = frameFor(`sprites.${impact.kind}`, impact.age / impact.ttl, assets);
    if (frame) {
      sprites.push({
        pos: impact.pos,
        image: frame,
        scale: impact.scale,
        kind: 'impact',
        alpha: 1 - impact.age / impact.ttl,
        lift01: impact.height ?? 0.45,
      });
    }
  }

  sprites
    .map((sprite) => {
      const dx = sprite.pos.x - player.pos.x;
      const dy = sprite.pos.y - player.pos.y;
      const forward = Math.cos(player.angle) * dx + Math.sin(player.angle) * dy;
      const lateral = -Math.sin(player.angle) * dx + Math.cos(player.angle) * dy;
      const angle = Math.atan2(lateral, forward);
      return { sprite, depth: forward, angle, dist: distance(player.pos, sprite.pos) };
    })
    .filter((item) => Math.abs(item.angle) < FOV * 0.75 && item.depth > 0.12)
    .sort((a, b) => b.depth - a.depth)
    .forEach(({ sprite, depth, angle, dist }) => {
      const screenX = (0.5 + Math.tan(angle) / Math.tan(FOV / 2) * 0.5) * viewport.w;
      const projectedUnit = viewport.h / Math.max(0.22, depth * WALL_PROJECTION_SCALE);
      const baseSize = projectedUnit * sprite.scale * spriteScaleForKind(sprite.kind);
      const aspect = sprite.image.width / Math.max(1, sprite.image.height);
      const stride = sprite.stridePhase === undefined ? 0 : Math.sin(sprite.stridePhase);
      const strideAmount = sprite.kind === 'enemy' || sprite.kind === 'player' ? Math.abs(stride) : 0;
      const width = Math.min(viewport.w * 0.86, baseSize * aspect * (1 + strideAmount * 0.035));
      const height = Math.min(
        viewport.h * (sprite.kind === 'boss' ? 1.35 : 0.92),
        baseSize * (1 - strideAmount * 0.025),
      );
      const floorY = viewport.y + viewport.h * HORIZON_RATIO + projectedUnit / 2;
      const bob = sprite.kind === 'pickup' ? Math.sin(state.time * 5.5 + sprite.pos.x) * Math.min(8, height * 0.08) : 0;
      // Impacts center at a real world height (so blood lands on short enemies' bodies);
      // everything else keeps its per-kind screen-space lift.
      const lift = sprite.kind === 'impact'
        ? projectedUnit * (sprite.lift01 ?? 0.45) - height / 2
        : spriteLiftForKind(sprite.kind, height);
      const footSink = spriteFootSinkForKind(sprite.kind, height);
      const bottom = clamp(floorY, viewport.y + viewport.h * 0.51, viewport.y + viewport.h * 1.04) - lift + footSink + bob;
      const walkSway = sprite.kind === 'enemy' ? stride * Math.min(7, width * 0.04) : 0;
      const x = viewport.x + screenX - width / 2 + walkSway;
      const y = bottom - height;

      // Per-column occlusion: scan the sprite's horizontal span against the wall z-buffer
      // and clip drawing to the visible runs, so bodies peek out from corners instead of
      // popping in only once fully exposed.
      const spanX0 = clamp(Math.floor(screenX - width / 2), 0, zBuffer.length - 1);
      const spanX1 = clamp(Math.ceil(screenX + width / 2), 0, zBuffer.length - 1);
      const runs: Array<[number, number]> = [];
      let runStart = -1;
      for (let col = spanX0; col <= spanX1; col += 1) {
        const colVisible = depth <= zBuffer[col] + 0.1;
        if (colVisible && runStart < 0) runStart = col;
        if (!colVisible && runStart >= 0) {
          runs.push([runStart, col]);
          runStart = -1;
        }
      }
      if (runStart >= 0) runs.push([runStart, spanX1 + 1]);
      if (!runs.length) return;
      const fullyVisible = runs.length === 1 && runs[0][0] === spanX0 && runs[0][1] === spanX1 + 1;

      ctx.save();
      if (!fullyVisible) {
        ctx.beginPath();
        for (const [from, to] of runs) {
          ctx.rect(viewport.x + from, viewport.y, to - from, viewport.h);
        }
        ctx.clip();
      }
      ctx.globalAlpha = sprite.alpha ?? 1;
      if (sprite.kind !== 'projectile' && sprite.kind !== 'impact') {
        const shadowWidth = width * (sprite.kind === 'boss' ? 0.55 : 0.42);
        const shadowHeight = clamp(height * 0.08, 3, 18);
        ctx.fillStyle = `rgba(0, 0, 0, ${clamp(0.42 - dist * 0.025, 0.14, 0.4)})`;
        ctx.beginPath();
        ctx.ellipse(viewport.x + screenX, bottom + shadowHeight * 0.25, shadowWidth, shadowHeight, 0, 0, Math.PI * 2);
        ctx.fill();
        if ((sprite.kind === 'enemy' || sprite.kind === 'player') && sprite.stridePhase !== undefined) {
          drawStrideContacts(ctx, viewport.x + screenX, bottom, width, height, stride);
        }
      }
      if (sprite.kind === 'pickup') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(viewport.x + screenX, bottom, 0, viewport.x + screenX, bottom, Math.max(8, width * 0.7));
        glow.addColorStop(0, 'rgba(255, 214, 142, 0.22)');
        glow.addColorStop(1, 'rgba(255, 214, 142, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(viewport.x + screenX, bottom, Math.max(8, width * 0.7), Math.max(4, height * 0.2), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.imageSmoothingEnabled = false;
      if (sprite.flash) ctx.filter = 'brightness(1.8)';
      ctx.drawImage(sprite.image, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
      if (sprite.flash) ctx.filter = 'none';
      if (dist > 5) {
        ctx.fillStyle = `rgba(10, 4, 7, ${clamp((dist - 5) / 12, 0, 0.42)})`;
        ctx.fillRect(x, y, width, height);
      }
      if (sprite.healthRatio !== undefined && sprite.healthRatio < 1) {
        const barWidth = clamp(width * 0.58, 28, 92);
        const barX = viewport.x + screenX - barWidth / 2;
        const barY = Math.max(viewport.y + 10, y - 9);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
        ctx.fillRect(barX, barY, barWidth, 4);
        ctx.fillStyle = sprite.kind === 'player' ? '#4ab7ff' : sprite.kind === 'boss' ? '#ffbe46' : '#e73f35';
        ctx.fillRect(barX, barY, barWidth * clamp(sprite.healthRatio, 0, 1), 4);
      }
      if (sprite.label) {
        const labelY = Math.max(viewport.y + 22, y - 16);
        ctx.font = `800 ${clamp(viewport.h * 0.022, 10, 13)}px "Arial", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillText(sprite.label, viewport.x + screenX + 1, labelY + 1);
        ctx.fillStyle = '#bfe2ff';
        ctx.fillText(sprite.label, viewport.x + screenX, labelY);
        ctx.textAlign = 'start';
      }
      ctx.restore();
    });
}

function spriteScaleForKind(kind: SpriteDraw['kind']) {
  switch (kind) {
    case 'boss':
      return 0.92;
    case 'enemy':
      return 0.82;
    case 'player':
      return 0.7;
    case 'prop':
      return 0.78;
    case 'pickup':
      return 0.64;
    case 'projectile':
      return 0.52;
    case 'impact':
      return 0.72;
  }
}

function spriteLiftForKind(kind: SpriteDraw['kind'], height: number) {
  switch (kind) {
    case 'pickup':
      return height * 0.12;
    case 'projectile':
      return height * 1.2;
    default:
      return 0;
  }
}

function spriteFootSinkForKind(kind: SpriteDraw['kind'], height: number) {
  switch (kind) {
    case 'boss':
      return height * 0.085;
    case 'enemy':
      return height * 0.06;
    case 'prop':
      return height * 0.035;
    default:
      return 0;
  }
}

function drawStrideContacts(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  bottom: number,
  width: number,
  height: number,
  stride: number,
) {
  const step = Math.sign(stride || 1);
  const footY = bottom + clamp(height * 0.012, 1, 4);
  const footW = clamp(width * 0.11, 5, 15);
  const footH = clamp(height * 0.025, 2, 6);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.beginPath();
  ctx.ellipse(centerX - width * 0.13, footY, footW * (step > 0 ? 1.35 : 0.82), footH, 0, 0, Math.PI * 2);
  ctx.ellipse(centerX + width * 0.13, footY, footW * (step > 0 ? 0.82 : 1.35), footH, 0, 0, Math.PI * 2);
  ctx.fill();
}

function addEnemySprite(sprites: SpriteDraw[], enemy: EnemyState, player: PlayerState, time: number, assets: LoadedAssets) {
  const manifestKey = enemyAnimationKey(enemy);
  const frame = enemy.health <= 0
    ? directionalFrameAtRatio(manifestKey, enemy.deathTimer / 0.8, enemy.facingAngle, angleTo(enemy.pos, player.pos), assets)
    : directionalAnimatedFrame(manifestKey, time + enemy.pos.x * 0.1, enemy.facingAngle, angleTo(enemy.pos, player.pos), assets);
  const sprite = assetManifest.sprites[manifestKey] ?? assetManifest.sprites[enemy.kind];
  if (frame) {
    sprites.push({
      pos: enemy.pos,
      image: frame,
      scale: sprite.scale * (enemy.painTimer > 0 ? 1.08 : 1),
      kind: 'enemy',
      healthRatio: enemy.health / enemy.maxHealth,
      stridePhase: time * enemyStrideSpeed(enemy.kind) + stablePhase(enemy.id),
      flash: enemy.painTimer > 0 && enemy.health > 0,
    });
  }
}

function enemyAnimationKey(enemy: EnemyState) {
  const prefix = enemy.kind;
  if (enemy.health <= 0) return `${prefix}Death`;
  if (enemy.painTimer > 0) return `${prefix}Hit`;
  if (enemy.cooldown > enemy.attackCooldown - 0.24) return `${prefix}Attack`;
  return `${prefix}Move`;
}

function enemyStrideSpeed(kind: EnemyState['kind']) {
  if (kind === 'drumImp') return 8.2;
  if (kind === 'rustAcolyte') return 4.2;
  return 5.7;
}

function stablePhase(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 628) / 100;
}

function addBossSprite(sprites: SpriteDraw[], boss: BossState, player: PlayerState, time: number, assets: LoadedAssets) {
  if (boss.defeated) return;
  const frame = directionalAnimatedFrame('sahurwoodBoss', time + (boss.beatTimer > 0 ? 0.2 : 0), boss.facingAngle, angleTo(boss.pos, player.pos), assets);
  if (frame) {
    sprites.push({
      pos: boss.pos,
      image: frame,
      scale: assetManifest.sprites.sahurwoodBoss.scale * (boss.phase === 3 ? 1.12 : 1),
      kind: 'boss',
      healthRatio: boss.health / boss.maxHealth,
      flash: boss.painTimer > 0,
    });
  }
}

function addPickupSprite(sprites: SpriteDraw[], pickup: PickupState, time: number, assets: LoadedAssets) {
  const frame = animatedFrame(pickup.kind, time, assets);
  if (frame) sprites.push({ pos: pickup.pos, image: frame, scale: assetManifest.sprites[pickup.kind].scale, kind: 'pickup' });
}

function addPlayerSprite(sprites: SpriteDraw[], target: PlayerState, viewer: PlayerState, assets: LoadedAssets) {
  const frame = directionalAnimatedFrame('playerMarine', 0, target.viewAngle, angleTo(target.pos, viewer.pos), assets);
  const sprite = assetManifest.sprites.playerMarine;
  if (!frame || !sprite) return;
  sprites.push({
    pos: target.pos,
    image: frame,
    scale: sprite.scale,
    kind: 'player',
    healthRatio: target.health / target.maxHealth,
    stridePhase: target.moveBlend > 0.08 ? target.bobPhase : undefined,
    label: target.name,
  });
}

function addPropSprite(sprites: SpriteDraw[], prop: PropState, assets: LoadedAssets) {
  if (prop.health === 0) return;
  const frame = animatedFrame(prop.kind, 0, assets);
  if (frame) sprites.push({ pos: prop.pos, image: frame, scale: assetManifest.sprites[prop.kind].scale, kind: 'prop' });
}

function addProjectileSprite(sprites: SpriteDraw[], projectile: ProjectileState, time: number, assets: LoadedAssets) {
  const frame = animatedFrame(projectile.kind, time, assets);
  if (frame) sprites.push({ pos: projectile.pos, image: frame, scale: assetManifest.sprites[projectile.kind].scale, kind: 'projectile' });
}

function animatedFrame(key: string, time: number, assets: LoadedAssets) {
  const sprite = assetManifest.sprites[key];
  if (!sprite) return undefined;
  const frameIndex = Math.floor(time * sprite.fps) % sprite.frames.length;
  return assets.images.get(sprite.frames[frameIndex]);
}

function directionalAnimatedFrame(key: string, time: number, facingAngle: number, viewerAngle: number, assets: LoadedAssets) {
  const sprite = assetManifest.sprites[key];
  if (!sprite?.directions || !sprite.framesPerDirection) return animatedFrame(key, time, assets);
  const direction = directionalIndex(facingAngle, viewerAngle, sprite.directions);
  const frame = Math.floor(time * sprite.fps) % sprite.framesPerDirection;
  return assets.images.get(sprite.frames[direction * sprite.framesPerDirection + frame]);
}

function frameFor(key: string, ratio: number, assets: LoadedAssets) {
  const mapped: Record<string, string> = {
    'sprites.blood': 'blood',
    'sprites.spark': 'spark',
    'sprites.woodBurst': 'woodBurst',
    'sprites.muzzle': 'muzzle',
  };
  const sprite = assetManifest.sprites[mapped[key]];
  if (!sprite) return undefined;
  const frameIndex = clamp(Math.floor(ratio * sprite.frames.length), 0, sprite.frames.length - 1);
  return assets.images.get(sprite.frames[frameIndex]);
}

function frameAtRatio(key: string, ratio: number, assets: LoadedAssets) {
  const sprite = assetManifest.sprites[key];
  if (!sprite) return undefined;
  const frameIndex = clamp(Math.floor(ratio * sprite.frames.length), 0, sprite.frames.length - 1);
  return assets.images.get(sprite.frames[frameIndex]);
}

function directionalFrameAtRatio(key: string, ratio: number, facingAngle: number, viewerAngle: number, assets: LoadedAssets) {
  const sprite = assetManifest.sprites[key];
  if (!sprite?.directions || !sprite.framesPerDirection) return frameAtRatio(key, ratio, assets);
  const direction = directionalIndex(facingAngle, viewerAngle, sprite.directions);
  const frame = clamp(Math.floor(ratio * sprite.framesPerDirection), 0, sprite.framesPerDirection - 1);
  return assets.images.get(sprite.frames[direction * sprite.framesPerDirection + frame]);
}

function directionalIndex(facingAngle: number, viewerAngle: number, directions: number) {
  const sector = Math.round(normalizeAngle(viewerAngle - facingAngle) / (Math.PI * 2 / directions));
  return (sector + directions) % directions;
}

function drawWeapon(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  state: GameState,
  assets: LoadedAssets,
) {
  if (!player.alive) return null;
  const weapon = weapons[player.weapon];
  const sprite = assetManifest.weapons[weapon.sprite];
  const image = weaponFrame(player, weapon.fireDuration, sprite, assets);
  if (!image) return null;
  const height = viewport.h * sprite.heightRatio;
  const width = height * (image.width / Math.max(1, image.height));
  const kick = player.weaponKick * viewport.h * 0.045;
  const moveSway = Math.sin(player.bobPhase) * player.moveBlend * viewport.w * 0.012;
  const idleSway = Math.sin(state.time * 5.5) * viewport.w * 0.003;
  const reloadRatio = reloadProgress(player);
  const reloadDip = reloadRatio === null ? 0 : Math.sin(reloadRatio * Math.PI) * viewport.h * 0.18;
  const reloadTilt = reloadRatio === null ? 0 : Math.sin(reloadRatio * Math.PI * 2) * 0.045;
  const fireTilt = player.fireTimer > 0 ? Math.sin((1 - player.fireTimer / weapon.fireDuration) * Math.PI) * -0.025 : 0;
  const sway = moveSway + idleSway;
  const x = viewport.x + viewport.w * sprite.xRatio - width * 0.5 + sway;
  const bob = Math.abs(Math.sin(player.bobPhase)) * player.moveBlend * viewport.h * 0.018;
  const y = viewport.y + viewport.h - height * 0.86 + kick + bob + reloadDip;
  const fade = ctx.createLinearGradient(0, y, 0, viewport.y + viewport.h);
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
  ctx.fillStyle = fade;
  ctx.fillRect(viewport.x, viewport.y + viewport.h * 0.72, viewport.w, viewport.h * 0.28);
  ctx.save();
  ctx.translate(x + width * 0.5, y + height * 0.55);
  ctx.rotate(reloadTilt + fireTilt);
  ctx.drawImage(image, -width * 0.5, -height * 0.55, width, height);
  ctx.restore();
  const flashSize = viewport.h * sprite.flashSizeRatio;
  if (player.muzzleTimer > 0 && !player.reloadWeapon) {
    const frame = animatedFrame('muzzle', state.time, assets);
    if (frame) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(frame, x + width * sprite.muzzleOffset.x, y + height * sprite.muzzleOffset.y, flashSize, flashSize);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  // Center of where the muzzle flash renders — tracers start here.
  return {
    x: x + width * sprite.muzzleOffset.x + flashSize / 2,
    y: y + height * sprite.muzzleOffset.y + flashSize / 2,
  };
}

function weaponFrame(
  player: PlayerState,
  fireDuration: number,
  sprite: (typeof assetManifest.weapons)[string],
  assets: LoadedAssets,
) {
  if (player.reloadWeapon === player.weapon && player.reloadDuration > 0) {
    const ratio = reloadProgress(player) ?? 0;
    const index = clamp(Math.floor(ratio * sprite.reload.length), 0, sprite.reload.length - 1);
    return assets.images.get(sprite.reload[index]);
  }
  if (player.fireTimer > 0) {
    const ratio = clamp(1 - player.fireTimer / Math.max(0.001, fireDuration), 0, 1);
    const index = clamp(Math.floor(ratio * sprite.fire.length), 0, sprite.fire.length - 1);
    return assets.images.get(sprite.fire[index]);
  }
  return assets.images.get(sprite.fire[0]);
}

function reloadProgress(player: PlayerState) {
  if (player.reloadWeapon !== player.weapon || player.reloadDuration <= 0) return null;
  return clamp(1 - player.reloadTimer / player.reloadDuration, 0, 1);
}

function drawViewportHud(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  player: PlayerState,
  state: GameState,
  assets: LoadedAssets,
  fx?: FxState,
) {
  ctx.save();
  const edgePad = clamp(viewport.w * 0.016, 6, 14);
  const centerX = viewport.x + viewport.w / 2;
  const centerY = viewport.y + viewport.h * HORIZON_RATIO;

  if (player.alive && player.muzzleTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const light = ctx.createRadialGradient(centerX, viewport.y + viewport.h * 0.82, 0, centerX, viewport.y + viewport.h * 0.82, viewport.h * 0.75);
    light.addColorStop(0, 'rgba(255, 176, 84, 0.16)');
    light.addColorStop(1, 'rgba(255, 176, 84, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(255, 238, 190, 0.72)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX - 9, centerY);
  ctx.lineTo(centerX - 3, centerY);
  ctx.moveTo(centerX + 3, centerY);
  ctx.lineTo(centerX + 9, centerY);
  ctx.moveTo(centerX, centerY - 9);
  ctx.lineTo(centerX, centerY - 3);
  ctx.moveTo(centerX, centerY + 3);
  ctx.lineTo(centerX, centerY + 9);
  ctx.stroke();

  if (fx && fx.hitMarker > 0) drawHitMarker(ctx, centerX, centerY, 'rgba(255, 238, 190, 0.9)', 7, 13);
  if (fx && fx.killMarker > 0) drawHitMarker(ctx, centerX, centerY, `rgba(255, 80, 60, ${clamp(fx.killMarker / 0.22, 0, 1)})`, 9, 18);

  if (!player.alive) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
    ctx.fillStyle = '#ffdca0';
    ctx.font = `800 ${clamp(viewport.h * 0.075, 18, 28)}px "Arial", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(player.deaths >= 3 ? 'OUT OF LIVES' : `RESPAWN IN ${player.respawnTimer.toFixed(1)}`, centerX, viewport.y + viewport.h * 0.48);
    ctx.textAlign = 'start';
  }

  if (player.hurtTimer > 0) {
    ctx.fillStyle = `rgba(186, 18, 18, ${Math.min(0.45, player.hurtTimer * 0.75)})`;
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
  }

  if (fx) {
    for (const dir of fx.damageDirs) {
      drawDamageWedge(ctx, viewport, centerX, centerY, normalizeAngle(dir.angle - player.viewAngle), clamp(dir.t / 0.9, 0, 1));
    }
  }

  if (player.alive && player.health <= 30) {
    const pulse = 0.08 + Math.max(0, Math.sin(state.time * 3)) * 0.14;
    const lowHp = ctx.createRadialGradient(centerX, centerY, viewport.h * 0.3, centerX, centerY, viewport.h * 0.85);
    lowHp.addColorStop(0, 'rgba(140, 8, 8, 0)');
    lowHp.addColorStop(1, `rgba(140, 8, 8, ${pulse})`);
    ctx.fillStyle = lowHp;
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
  }

  if (fx?.screenFlash) {
    const flash = fx.screenFlash;
    ctx.fillStyle = `rgba(${flash.color}, ${flash.alpha * clamp(flash.t / flash.duration, 0, 1)})`;
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
  }
  if (fx && fx.respawnFade > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${clamp(fx.respawnFade / 0.45, 0, 1) * 0.85})`;
    ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);
  }

  if (state.boss.active && !state.boss.defeated) {
    drawBossBar(ctx, viewport, state, fx);
  }

  if (fx) drawKillFeed(ctx, viewport, fx);

  const objectiveWidth = Math.min(520, viewport.w - edgePad * 2);
  const objectiveX = viewport.x + viewport.w * 0.5 - objectiveWidth / 2;
  const objectiveY = viewport.y + viewport.h - 48;
  ctx.fillStyle = 'rgba(9, 8, 10, 0.78)';
  ctx.fillRect(objectiveX, objectiveY, objectiveWidth, 34);
  ctx.strokeStyle = 'rgba(255, 214, 142, 0.22)';
  ctx.strokeRect(objectiveX, objectiveY, objectiveWidth, 34);
  ctx.fillStyle = '#ffe2a2';
  ctx.font = `700 ${clamp(viewport.w / 44, 11, 13)}px "Arial", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, state.objective, objectiveWidth - 24), viewport.x + viewport.w * 0.5, objectiveY + 22);
  ctx.textAlign = 'start';
  ctx.restore();
}

function drawHitMarker(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, style: string, inner: number, outer: number) {
  ctx.strokeStyle = style;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.moveTo(centerX + dx * inner, centerY + dy * inner);
    ctx.lineTo(centerX + dx * outer, centerY + dy * outer);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

// relativeAngle 0 = damage came from straight ahead; wedge slides around the screen edge.
function drawDamageWedge(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  centerX: number,
  centerY: number,
  relativeAngle: number,
  strength: number,
) {
  const radius = Math.min(viewport.w, viewport.h) * 0.36;
  const dirX = Math.sin(relativeAngle);
  const dirY = -Math.cos(relativeAngle);
  const tipX = centerX + dirX * radius;
  const tipY = centerY + dirY * radius;
  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.rotate(Math.atan2(dirY, dirX) + Math.PI / 2);
  ctx.fillStyle = `rgba(214, 28, 22, ${0.55 * strength})`;
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(13, 6);
  ctx.lineTo(-13, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBossBar(ctx: CanvasRenderingContext2D, viewport: Viewport, state: GameState, fx?: FxState) {
  const width = Math.min(440, viewport.w * 0.5);
  const x = viewport.x + viewport.w / 2 - width / 2;
  const y = viewport.y + clamp(viewport.h * 0.045, 18, 32);
  const ratio = clamp(state.boss.health / state.boss.maxHealth, 0, 1);
  ctx.save();
  ctx.font = `900 ${clamp(viewport.w / 70, 12, 15)}px "Arial Black", "Arial", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillText('SAHURWOOD NIGHTMARE', viewport.x + viewport.w / 2 + 1, y - 5);
  ctx.fillStyle = '#ffbe46';
  ctx.fillText('SAHURWOOD NIGHTMARE', viewport.x + viewport.w / 2, y - 6);
  ctx.textAlign = 'start';

  ctx.fillStyle = 'rgba(8, 6, 8, 0.82)';
  ctx.fillRect(x - 2, y - 2, width + 4, 14);
  ctx.strokeStyle = 'rgba(255, 190, 70, 0.45)';
  ctx.strokeRect(x - 2.5, y - 2.5, width + 5, 15);
  const flash = fx && fx.bossBarFlash > 0 ? clamp(fx.bossBarFlash / 0.4, 0, 1) : 0;
  ctx.fillStyle = flash > 0 ? `rgba(255, 255, 255, ${0.4 + flash * 0.6})` : state.boss.phase === 3 ? '#ff5a3c' : '#ffbe46';
  ctx.fillRect(x, y, width * ratio, 10);
  // Notches at the phase thresholds so players can read the fight's structure.
  ctx.fillStyle = 'rgba(12, 8, 8, 0.9)';
  for (const threshold of [0.65, 0.3]) {
    ctx.fillRect(x + width * threshold - 1, y - 1, 2, 12);
  }
  ctx.restore();
}

function drawKillFeed(ctx: CanvasRenderingContext2D, viewport: Viewport, fx: FxState) {
  const x = viewport.x + clamp(viewport.w * 0.016, 8, 16);
  let y = viewport.y + clamp(viewport.h * 0.05, 20, 36);
  ctx.save();
  ctx.font = `800 ${clamp(viewport.w / 78, 11, 14)}px "Arial", sans-serif`;
  for (const entry of fx.feed) {
    const alpha = entry.t > 3 ? clamp(1 - (entry.t - 3), 0, 1) : 1;
    ctx.fillStyle = `rgba(0, 0, 0, ${0.65 * alpha})`;
    ctx.fillText(entry.text, x + 1, y + 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = entry.color;
    ctx.fillText(entry.text, x, y);
    ctx.globalAlpha = 1;
    y += clamp(viewport.h * 0.032, 16, 22);
  }
  ctx.restore();
}

function drawDoomStatusBar(
  ctx: CanvasRenderingContext2D,
  bar: Viewport,
  player: PlayerState,
  state: GameState,
  assets: LoadedAssets,
  fx?: FxState,
) {
  const centerX = bar.x + bar.w / 2;
  const facePad = 9;
  const faceSize = bar.h - facePad * 2 - 14;
  const faceX = centerX - faceSize / 2;
  const faceY = bar.y + facePad;
  const gap = clamp(bar.w * 0.03, 24, 48);
  const sidePad = clamp(bar.w * 0.03, 16, 56);
  const leftX = bar.x + sidePad;
  const leftW = faceX - gap - leftX;
  const rightX = faceX + faceSize + gap;
  const rightW = bar.x + bar.w - sidePad - rightX;
  const score = state.scores[player.id];
  const weapon = weapons[player.weapon];
  const reserve = player[weapon.reserve];
  const baseFont = clamp(bar.w / 86, 11, 14);
  const numberFont = clamp(bar.h * 0.34, 24, 36);
  const row1 = bar.y + numberFont + 12;
  const row2 = bar.y + bar.h - 14;
  const healthBump = fx ? 1 + clamp(fx.hudBumps.health / 0.3, 0, 1) * 0.25 : 1;
  const ammoBump = fx ? 1 + clamp(fx.hudBumps.ammo / 0.3, 0, 1) * 0.25 : 1;

  // Full-width opaque strip — its own region below the 3D view, nothing to occlude.
  const gradient = ctx.createLinearGradient(0, bar.y, 0, bar.y + bar.h);
  gradient.addColorStop(0, '#241a16');
  gradient.addColorStop(0.12, '#171010');
  gradient.addColorStop(0.6, '#100a0b');
  gradient.addColorStop(1, '#060405');
  ctx.fillStyle = gradient;
  ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
  ctx.fillStyle = 'rgba(255, 190, 92, 0.45)';
  ctx.fillRect(bar.x, bar.y, bar.w, 2);
  ctx.fillStyle = 'rgba(255, 222, 155, 0.08)';
  ctx.fillRect(bar.x, bar.y + 2, bar.w, 1);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  for (let i = 0; i < bar.w; i += 26) ctx.fillRect(bar.x + i, bar.y + 4, 1, bar.h - 8);

  ctx.textAlign = 'left';
  const hpColor = player.health <= 30 ? '#ff6358' : '#ffde9b';
  drawReadout(ctx, 'HEALTH', `${Math.ceil(player.health)}`, leftX, row1, numberFont * healthBump, hpColor);
  drawMeter(ctx, leftX, row1 + 10, Math.min(150, leftW * 0.3), player.health / player.maxHealth, hpColor);
  drawReadout(ctx, 'ARMOR', `${Math.round(player.armor)}`, leftX + leftW * 0.42, row1, numberFont * 0.76 * healthBump, '#6cc8ff');
  drawMeter(ctx, leftX + leftW * 0.42, row1 + 10, Math.min(120, leftW * 0.24), player.armor / 80, '#6cc8ff');
  ctx.font = `900 ${baseFont}px "Arial", sans-serif`;
  ctx.fillStyle = 'rgba(246, 238, 225, 0.82)';
  ctx.fillText(`SCORE ${score.total}`, leftX, row2);
  ctx.fillStyle = 'rgba(246, 238, 225, 0.6)';
  ctx.fillText(`KILLS ${score.kills}`, leftX + leftW * 0.42, row2);
  if (fx?.scoreDelta) {
    ctx.font = `900 ${baseFont + 5}px "Arial", sans-serif`;
    ctx.fillStyle = `rgba(255, 222, 155, ${clamp(fx.scoreDelta.t / 0.8, 0, 1)})`;
    ctx.fillText(`+${fx.scoreDelta.value}`, leftX + leftW * 0.24, row2 - (0.8 - fx.scoreDelta.t) * 16);
  }

  drawReadout(ctx, 'AMMO', `${player.magazines[player.weapon]}/${reserve}`, rightX, row1, numberFont * ammoBump, '#ffde9b');
  drawMeter(ctx, rightX, row1 + 10, Math.min(150, rightW * 0.3), player.magazines[player.weapon] / weapon.magazineSize, '#ffde9b');
  drawLivesPips(ctx, rightX + rightW * 0.46, bar.y + 16, Math.max(0, 3 - player.deaths), baseFont);
  drawArmsList(ctx, rightX, row2 - 12, player, baseFont);

  drawFaceSlot(ctx, faceX, faceY, faceSize, player, state, assets);

  ctx.font = `900 ${baseFont + 1}px "Arial", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillText(fitText(ctx, player.name.toUpperCase(), faceSize + 48), centerX + 1, bar.y + bar.h - 5);
  ctx.fillStyle = '#ffd791';
  ctx.fillText(fitText(ctx, player.name.toUpperCase(), faceSize + 48), centerX, bar.y + bar.h - 6);
  ctx.textAlign = 'start';
}

function drawLivesPips(ctx: CanvasRenderingContext2D, x: number, y: number, lives: number, baseFont: number) {
  ctx.font = `900 ${Math.max(9, baseFont * 0.78)}px "Arial", sans-serif`;
  ctx.fillStyle = '#ffd791';
  ctx.fillText('LIVES', x, y + 4);
  for (let i = 0; i < 3; i += 1) {
    const pipX = x + i * 18;
    const pipY = y + 16;
    ctx.save();
    ctx.translate(pipX + 6, pipY);
    ctx.rotate(Math.PI / 4);
    if (i < lives) {
      ctx.fillStyle = '#ffbe46';
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.strokeRect(-5, -5, 10, 10);
    } else {
      ctx.strokeStyle = 'rgba(255, 190, 92, 0.35)';
      ctx.strokeRect(-5, -5, 10, 10);
    }
    ctx.restore();
  }
}

function drawArmsList(ctx: CanvasRenderingContext2D, x: number, y: number, player: PlayerState, baseFont: number) {
  const entries: Array<{ key: string; label: string; id: PlayerState['weapon'] }> = [
    { key: '1', label: 'PISTOL', id: 'stakePistol' },
    { key: '2', label: 'SHOTGUN', id: 'ribShotgun' },
  ];
  ctx.font = `900 ${baseFont}px "Arial", sans-serif`;
  let drawX = x;
  for (const entry of entries) {
    const text = `${entry.key} ${entry.label}`;
    const active = player.weapon === entry.id;
    ctx.fillStyle = '#17100e';
    ctx.fillText(text, drawX + 1, y + 13);
    ctx.fillStyle = active ? '#ffcf7a' : 'rgba(246, 238, 225, 0.45)';
    ctx.fillText(text, drawX, y + 12);
    drawX += ctx.measureText(text).width + 14;
  }
}

function drawFaceSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  player: PlayerState,
  state: GameState,
  assets: LoadedAssets,
) {
  const face = statusFaceFor(player, state, assets);
  if (!face) return;
  const pulse = player.hurtTimer > 0 || player.fireTimer > 0 ? Math.sin(state.time * 48) * 2 : 0;
  const pad = Math.max(7, size * 0.07);
  const frameX = x - pad;
  const frameY = y - pad;
  const frameSize = size + pad * 2;
  const notch = Math.max(10, frameSize * 0.14);

  // Octagonal portrait frame — the centerpiece of the HUD.
  ctx.save();
  ctx.beginPath();
  octagonPath(ctx, frameX, frameY, frameSize, notch);
  const plate = ctx.createLinearGradient(0, frameY, 0, frameY + frameSize);
  plate.addColorStop(0, 'rgba(58, 46, 38, 0.92)');
  plate.addColorStop(0.5, 'rgba(26, 19, 17, 0.92)');
  plate.addColorStop(1, 'rgba(10, 7, 8, 0.95)');
  ctx.fillStyle = plate;
  ctx.fill();
  const lowHp = player.health <= 30;
  const bossFight = state.boss.active && !state.boss.defeated;
  ctx.strokeStyle = lowHp
    ? `rgba(255, 99, 88, ${0.7 + Math.max(0, Math.sin(state.time * 5)) * 0.3})`
    : bossFight
      ? 'rgba(255, 207, 122, 0.85)'
      : 'rgba(255, 190, 92, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  octagonPath(ctx, frameX + 3.5, frameY + 3.5, frameSize - 7, notch - 2);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  octagonPath(ctx, x, y, size, Math.max(7, size * 0.12));
  ctx.clip();
  ctx.fillStyle = '#120f10';
  ctx.fillRect(x, y, size, size);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(face, x + pulse, y + pulse * 0.4, size, size);
  // inner vignette keeps the portrait grounded against the translucent HUD
  const inner = ctx.createRadialGradient(x + size / 2, y + size / 2, size * 0.32, x + size / 2, y + size / 2, size * 0.72);
  inner.addColorStop(0, 'rgba(0, 0, 0, 0)');
  inner.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
  ctx.fillStyle = inner;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(x + 4, y + 3, size - 8, 2);
  ctx.restore();
}

function octagonPath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, notch: number) {
  ctx.moveTo(x + notch, y);
  ctx.lineTo(x + size - notch, y);
  ctx.lineTo(x + size, y + notch);
  ctx.lineTo(x + size, y + size - notch);
  ctx.lineTo(x + size - notch, y + size);
  ctx.lineTo(x + notch, y + size);
  ctx.lineTo(x, y + size - notch);
  ctx.lineTo(x, y + notch);
  ctx.closePath();
}

function statusFaceFor(player: PlayerState, state: GameState, assets: LoadedAssets) {
  const sprite = assetManifest.sprites.statusFace;
  if (!sprite) return undefined;
  let frameIndex = 0;
  if (state.mode === 'won') frameIndex = 5;
  else if (!player.alive) frameIndex = 4;
  else if (state.boss.active && !state.boss.defeated) frameIndex = 3;
  else if (player.faceAngryTimer > 0 || player.hurtTimer > 0 || player.muzzleTimer > 0 || player.fireTimer > 0 || player.cooldown > 0.02 || player.reloadWeapon) frameIndex = 1;
  else if (player.health <= 32) frameIndex = 3;
  return assets.images.get(sprite.frames[frameIndex]);
}

function drawReadout(ctx: CanvasRenderingContext2D, label: string, value: string, x: number, y: number, valueSize: number, color: string) {
  const labelSize = Math.max(9, valueSize * 0.42);
  ctx.font = `900 ${valueSize}px "Arial Black", "Arial", sans-serif`;
  ctx.fillStyle = '#130e0d';
  ctx.fillText(value, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
  ctx.font = `900 ${labelSize}px "Arial", sans-serif`;
  ctx.fillStyle = '#17100e';
  ctx.fillText(label, x + 1, y + labelSize + 3);
  ctx.fillStyle = '#ffd791';
  ctx.fillText(label, x, y + labelSize + 2);
}

function drawMeter(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, ratio: number, color: string) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(x, y, width, 8);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * clamp(ratio, 0, 1), 8);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(x, y, width, 1);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 8 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed.trim()}...`;
}

function drawBriefing(ctx: CanvasRenderingContext2D, size: { width: number; height: number }, assets: LoadedAssets) {
  ctx.save();
  ctx.fillStyle = 'rgba(3, 3, 6, 0.88)';
  ctx.fillRect(0, 0, size.width, size.height);
  const glow = ctx.createRadialGradient(size.width * 0.42, size.height * 0.46, 0, size.width * 0.42, size.height * 0.46, size.width * 0.64);
  glow.addColorStop(0, 'rgba(255, 178, 78, 0.16)');
  glow.addColorStop(0.48, 'rgba(80, 24, 24, 0.12)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size.width, size.height);
  const map = assets.images.get(assetManifest.textures.mapPreview);
  if (map) {
    const side = Math.min(size.height * 0.62, size.width * 0.32);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.46)';
    ctx.fillRect(size.width * 0.08 - 10, size.height * 0.19 - 10, side + 20, side + 20);
    ctx.strokeStyle = 'rgba(255, 214, 142, 0.24)';
    ctx.strokeRect(size.width * 0.08 - 10, size.height * 0.19 - 10, side + 20, side + 20);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(map, size.width * 0.08, size.height * 0.19, side, side);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = '#ffe1a2';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 12;
  ctx.font = `900 ${clamp(size.width / 24, 34, 52)}px "Arial Black", "Arial", sans-serif`;
  ctx.fillText('DOOMETRIUS', size.width * 0.44, size.height * 0.28);
  ctx.shadowBlur = 0;
  ctx.font = `700 ${clamp(size.width / 70, 15, 18)}px "Arial", sans-serif`;
  ctx.fillStyle = '#f6eee1';
  ctx.fillText('WASD moves. Mouse-look (click to lock) or Q/E/arrows turn. Shift sprints.', size.width * 0.44, size.height * 0.36);
  ctx.fillStyle = '#c7bca9';
  ctx.fillText('Click or F fires. R reloads. 1/2 or mouse wheel swaps weapons.', size.width * 0.44, size.height * 0.43);
  ctx.fillText('Two marines fight side by side. Clear the rooms, break Sahurwood, extract.', size.width * 0.44, size.height * 0.5);
  ctx.fillStyle = '#ffbe46';
  ctx.font = '900 22px "Arial", sans-serif';
  ctx.fillText('PRESS FIRE TO START', size.width * 0.44, size.height * 0.62);
  ctx.restore();
}

function drawEndState(ctx: CanvasRenderingContext2D, size: { width: number; height: number }, state: GameState) {
  const mode = state.mode === 'won' ? 'won' : 'lost';
  ctx.save();
  ctx.fillStyle = mode === 'won' ? 'rgba(4, 15, 10, 0.88)' : 'rgba(22, 2, 4, 0.9)';
  ctx.fillRect(0, 0, size.width, size.height);
  const glow = ctx.createRadialGradient(size.width / 2, size.height * 0.36, 0, size.width / 2, size.height * 0.36, size.width * 0.48);
  glow.addColorStop(0, mode === 'won' ? 'rgba(105, 255, 143, 0.18)' : 'rgba(255, 65, 55, 0.18)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.fillStyle = mode === 'won' ? '#b9ff9f' : '#ff6d5f';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.86)';
  ctx.shadowBlur = 14;
  ctx.font = `900 ${clamp(size.width / 18, 38, 64)}px "Arial Black", "Arial", sans-serif`;
  ctx.fillText(mode === 'won' ? 'MISSION COMPLETE' : 'MISSION FAILED', size.width / 2, size.height * 0.3);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f6eee1';
  ctx.font = '700 18px "Arial", sans-serif';
  ctx.fillText(mode === 'won' ? 'The blacksite is clear. Extraction route open.' : 'The team was overrun inside the blacksite.', size.width / 2, size.height * 0.37);

  drawScoreTable(ctx, size, state);

  ctx.fillStyle = '#ffcf7a';
  ctx.font = '900 20px "Arial", sans-serif';
  ctx.fillText('PRESS R TO RESTART', size.width / 2, size.height * 0.82);
  ctx.textAlign = 'start';
  ctx.restore();
}

function drawScoreTable(ctx: CanvasRenderingContext2D, size: { width: number; height: number }, state: GameState) {
  const width = Math.min(560, size.width * 0.7);
  const x = size.width / 2 - width / 2;
  const y = size.height * 0.44;
  const rowHeight = 34;
  const columns = ['', 'KILLS', 'DAMAGE', 'ITEMS', 'DEATHS', 'SCORE'];
  const columnX = (index: number) => x + width * (index === 0 ? 0.04 : 0.18 + (index - 1) * 0.16);

  ctx.fillStyle = 'rgba(8, 8, 12, 0.78)';
  ctx.fillRect(x, y, width, rowHeight * 3 + 14);
  ctx.strokeStyle = 'rgba(255, 214, 142, 0.25)';
  ctx.strokeRect(x, y, width, rowHeight * 3 + 14);

  ctx.font = '900 13px "Arial", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c7bca9';
  for (let i = 1; i < columns.length; i += 1) ctx.fillText(columns[i], columnX(i), y + 24);

  const totals = playerIds.map((id) => state.scores[id].total);
  const mvp = totals[0] === totals[1] ? null : totals[0] > totals[1] ? playerIds[0] : playerIds[1];

  playerIds.forEach((id, index) => {
    const score = state.scores[id];
    const rowY = y + 24 + rowHeight * (index + 1);
    ctx.font = '900 15px "Arial", sans-serif';
    ctx.fillStyle = id === mvp ? '#ffcf7a' : '#f6eee1';
    ctx.fillText(`${state.players[id].name.toUpperCase()}${id === mvp ? '  - MVP' : ''}`, columnX(0), rowY);
    ctx.font = '700 15px "Arial", sans-serif';
    const values = [score.kills, Math.round(score.damage), score.pickups, score.deaths, score.total];
    values.forEach((value, column) => {
      ctx.fillText(`${value}`, columnX(column + 1), rowY);
    });
  });
  ctx.textAlign = 'center';
}

export type SpriteFrameSet = {
  frames: string[];
  fps: number;
  scale: number;
  directions?: number;
  framesPerDirection?: number;
};

export type WeaponFrameSet = {
  fire: string[];
  reload: string[];
  heightRatio: number;
  xRatio: number;
  muzzleOffset: { x: number; y: number };
  flashSizeRatio: number;
};

export type AssetManifest = {
  textures: Record<string, string>;
  sprites: Record<string, SpriteFrameSet>;
  weapons: Record<string, WeaponFrameSet>;
  ui: Record<string, string>;
};

export const assetManifest: AssetManifest = {
  textures: {
    bone: '/assets/textures/wall-bone.png',
    rust: '/assets/textures/wall-rust.png',
    meat: '/assets/textures/wall-meat.png',
    door: '/assets/textures/wall-door.png',
    boss: '/assets/textures/wall-boss.png',
    floor: '/assets/textures/floor.png',
    ceiling: '/assets/textures/ceiling.png',
    mapPreview: '/assets/map/nocturne-foundry-preview.png',
  },
  sprites: {
    splinterGhoul: {
      frames: directionalEnemyFrames('splinter-ghoul', 'idle'),
      fps: 6,
      scale: 0.9,
      directions: 8,
      framesPerDirection: 6,
    },
    splinterGhoulMove: directionalEnemySet('splinter-ghoul', 'move', 9, 0.9),
    splinterGhoulAttack: directionalEnemySet('splinter-ghoul', 'attack', 12, 0.96),
    splinterGhoulHit: directionalEnemySet('splinter-ghoul', 'hit', 12, 0.94),
    splinterGhoulDeath: directionalEnemySet('splinter-ghoul', 'death', 8, 0.9),
    rustAcolyte: {
      frames: directionalEnemyFrames('rust-acolyte', 'idle'),
      fps: 5,
      scale: 0.95,
      directions: 8,
      framesPerDirection: 6,
    },
    rustAcolyteMove: directionalEnemySet('rust-acolyte', 'move', 7, 0.95),
    rustAcolyteAttack: directionalEnemySet('rust-acolyte', 'attack', 11, 1),
    rustAcolyteHit: directionalEnemySet('rust-acolyte', 'hit', 11, 0.98),
    rustAcolyteDeath: directionalEnemySet('rust-acolyte', 'death', 8, 0.95),
    drumImp: {
      frames: directionalEnemyFrames('drum-imp', 'idle'),
      fps: 7,
      scale: 0.75,
      directions: 8,
      framesPerDirection: 6,
    },
    drumImpMove: directionalEnemySet('drum-imp', 'move', 13, 0.78),
    drumImpAttack: directionalEnemySet('drum-imp', 'attack', 14, 0.82),
    drumImpHit: directionalEnemySet('drum-imp', 'hit', 12, 0.8),
    drumImpDeath: directionalEnemySet('drum-imp', 'death', 9, 0.78),
    sahurwoodBoss: {
      frames: directionalBossFrames('sahurwood-nightmare', 'idle'),
      fps: 6,
      scale: 2.15,
      directions: 8,
      framesPerDirection: 6,
    },
    playerMarine: {
      frames: frameRange('/assets/players/marine/directional', 'direction', 1, 8),
      fps: 1,
      scale: 0.92,
      directions: 8,
      framesPerDirection: 1,
    },
    statusFace: {
      frames: [
        '/assets/ui/status-face/face-1.png',
        '/assets/ui/status-face/face-2.png',
        '/assets/ui/status-face/face-3.png',
        '/assets/ui/status-face/face-4.png',
        '/assets/ui/status-face/face-5.png',
        '/assets/ui/status-face/face-6.png',
      ],
      fps: 6,
      scale: 1,
    },
    medkit: { frames: ['/assets/pickups/medkit/clean.png'], fps: 1, scale: 0.35 },
    ammo: { frames: ['/assets/pickups/ammo/clean.png'], fps: 1, scale: 0.35 },
    shells: { frames: ['/assets/pickups/shells/clean.png'], fps: 1, scale: 0.35 },
    armor: { frames: ['/assets/pickups/armor/clean.png'], fps: 1, scale: 0.4 },
    barrel: { frames: ['/assets/props/barrel/clean.png'], fps: 1, scale: 0.65 },
    pillar: { frames: ['/assets/props/pillar/clean.png'], fps: 1, scale: 1.2 },
    torch: { frames: ['/assets/props/torch/clean.png'], fps: 1, scale: 0.8 },
    bones: { frames: ['/assets/props/bones/clean.png'], fps: 1, scale: 0.45 },
    enemyBolt: {
      frames: frameRange('/assets/fx/green-bolt', 'projectile', 1, 8),
      fps: 14,
      scale: 0.28,
    },
    bossBeat: {
      frames: frameRange('/assets/fx/wooden-beat', 'projectile', 1, 8),
      fps: 12,
      scale: 0.5,
    },
    blood: {
      frames: frameRange('/assets/fx/blood-impact', 'impact', 1, 8),
      fps: 18,
      scale: 0.6,
    },
    spark: {
      frames: frameRange('/assets/fx/spark-impact', 'impact', 1, 8),
      fps: 18,
      scale: 0.55,
    },
    woodBurst: {
      frames: frameRange('/assets/fx/wood-burst', 'impact', 1, 8),
      fps: 16,
      scale: 0.75,
    },
    muzzle: {
      frames: frameRange('/assets/fx/muzzle-flash', 'impact', 1, 8),
      fps: 24,
      scale: 0.45,
    },
  },
  weapons: {
    stakePistol: {
      fire: frameRange('/assets/weapons/stake-pistol', 'frame', 1, 6),
      reload: frameRange('/assets/weapons/stake-pistol', 'frame', 7, 12),
      heightRatio: 0.42,
      xRatio: 0.61,
      muzzleOffset: { x: 0.55, y: 0.28 },
      flashSizeRatio: 0.16,
    },
    ribShotgun: {
      fire: frameRange('/assets/weapons/rib-shotgun', 'frame', 1, 6),
      reload: frameRange('/assets/weapons/rib-shotgun', 'frame', 7, 12),
      heightRatio: 0.48,
      xRatio: 0.5,
      muzzleOffset: { x: 0.5, y: 0.2 },
      flashSizeRatio: 0.18,
    },
  },
  ui: {},
};

export type LoadedAssets = {
  images: Map<string, HTMLImageElement>;
};

function directionalEnemySet(slug: string, action: string, fps: number, scale: number): SpriteFrameSet {
  return {
    frames: directionalEnemyFrames(slug, action),
    fps,
    scale,
    directions: 8,
    framesPerDirection: 6,
  };
}

function directionalEnemyFrames(slug: string, action: string) {
  return frameRange(`/assets/enemies/${slug}/${action}`, action, 1, 48);
}

function directionalBossFrames(slug: string, action: string) {
  return frameRange(`/assets/boss/${slug}/${action}`, action, 1, 48);
}

function frameRange(basePath: string, prefix: string, start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => `${basePath}/${prefix}-${start + index}.png`);
}

export async function loadAssets(manifest = assetManifest): Promise<LoadedAssets> {
  const urls = new Set<string>();

  Object.values(manifest.textures).forEach((url) => urls.add(url));
  Object.values(manifest.weapons).forEach((weapon) => {
    weapon.fire.forEach((url) => urls.add(url));
    weapon.reload.forEach((url) => urls.add(url));
  });
  Object.values(manifest.ui).forEach((url) => urls.add(url));
  Object.values(manifest.sprites).forEach((sprite) => sprite.frames.forEach((url) => urls.add(url)));

  const images = new Map<string, HTMLImageElement>();
  const queue = [...urls];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(18, queue.length) }, async () => {
    while (cursor < queue.length) {
      const url = queue[cursor];
      cursor += 1;
      images.set(url, await loadImage(url));
    }
  });
  await Promise.all(workers);

  return { images };
}

async function loadImage(url: string) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await loadImageOnce(url);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 80 * attempt));
    }
  }
  throw new Error(`Missing generated asset: ${url}`);
}

function loadImageOnce(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Missing generated asset: ${url}`));
    img.src = url;
  });
}

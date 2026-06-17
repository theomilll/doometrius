#!/usr/bin/env python3
"""One-time utility: strip residual magenta chroma-key fringe from sprite PNGs.

The sprites were keyed off a magenta background (255,0,255); the keying left
pink-tinted pixels on antialiased edges. Each keyed pixel is effectively
   P = a*F + (1-a)*M,  M = (255,0,255), a = alpha/255
so the true foreground is recovered with  F = (P - (1-a)*M) / a.

Only partially-transparent, magenta-biased edge pixels are touched; solid
interior (a==255) and fully transparent (a==0) pixels are left untouched, and
alpha is never modified -- so silhouettes / crop bounds stay identical.

Runtime-loaded keyed sprites only (mirrors src/game/assets/manifest.ts);
textures (opaque, not keyed) and pipeline intermediates are skipped.
Originals are backed up to <repo>/.sprite-backup/ before overwriting.
"""
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "public" / "assets"
BACKUP = REPO / ".sprite-backup"

MATTE = np.array([255.0, 0.0, 255.0])  # magenta key color

# Roots holding keyed sprites (NOT textures/map).
ROOTS = ["enemies", "boss", "ui", "pickups", "props", "fx", "weapons"]
# Runtime frame filenames: <action>-N.png / projectile-N / impact-N / frame-N /
# face-N, plus the single-frame pickups/props "clean.png".
RUNTIME_RE = re.compile(
    r"^(?:idle|move|attack|hit|death|projectile|impact|frame|face)-\d+\.png$"
    r"|^clean\.png$"
)


def target_files():
    for root in ROOTS:
        base = ASSETS / root
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*.png")):
            if RUNTIME_RE.match(p.name):
                yield p


def defringe(path: Path) -> int:
    arr = np.array(Image.open(path).convert("RGBA")).astype(np.float64)
    R, G, B, A = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    a = A / 255.0
    mask = (A > 0) & (A < 255) & (np.minimum(R, B) > G)
    if not mask.any():
        return 0
    inv = (1.0 - a)[..., None]
    rgb = arr[..., :3]
    recovered = np.clip((rgb - inv * MATTE) / a[..., None], 0, 255)
    arr[..., :3] = np.where(mask[..., None], recovered, rgb)
    out = np.clip(np.rint(arr), 0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(path)
    return int(mask.sum())


def main():
    files = list(target_files())
    print(f"Processing {len(files)} keyed sprite PNGs\n")
    total_px = 0
    total_changed_files = 0
    for p in files:
        rel = p.relative_to(ASSETS)
        bak = BACKUP / rel
        if not bak.exists():  # preserve pristine original; safe to re-run
            bak.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, bak)
        n = defringe(p)
        total_px += n
        if n:
            total_changed_files += 1
    print(f"Backed up originals to {BACKUP}")
    print(f"De-fringed {total_changed_files}/{len(files)} files, "
          f"{total_px} edge pixels corrected")


if __name__ == "__main__":
    main()

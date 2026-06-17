// Procedural sound bank: every effect is synthesized into an AudioBuffer at startup
// (sfxr-style noise bursts, pitch sweeps and one-pole filters). No audio assets needed.

export type SoundName =
  | 'pistol'
  | 'shotgun'
  | 'dryClick'
  | 'reloadClipOut'
  | 'reloadClipIn'
  | 'weaponSwitch'
  | 'splat'
  | 'ricochet'
  | 'woodBreak'
  | 'hurt'
  | 'heartbeat'
  | 'footstep'
  | 'pickupHealth'
  | 'pickupAmmo'
  | 'pickupShells'
  | 'pickupArmor'
  | 'growl'
  | 'enemyDeath'
  | 'bossBeat'
  | 'bossRoar'
  | 'whoosh'
  | 'stingerWin'
  | 'stingerLose'
  | 'uiClick';

type Fill = (t: number) => number;

export function buildSoundBank(ctx: BaseAudioContext): Map<SoundName, AudioBuffer> {
  const bank = new Map<SoundName, AudioBuffer>();
  const add = (name: SoundName, seconds: number, makeFill: () => Fill) => {
    bank.set(name, render(ctx, seconds, makeFill()));
  };

  add('pistol', 0.26, () => {
    const crackLP = onePole(2600, ctx.sampleRate);
    return (t) => {
      const crack = (random() * 2 - 1) * Math.exp(-t * 90);
      const highCrack = crack - crackLP(crack);
      const body = Math.sin(sweepPhase(t, 180, 55, 0.09)) * Math.exp(-t * 26) * 0.9;
      return highCrack * 1.1 + body;
    };
  });

  add('shotgun', 0.55, () => {
    const boomLP = onePole(1400, ctx.sampleRate);
    const tailLP = onePole(700, ctx.sampleRate);
    return (t) => {
      const boom = Math.sin(sweepPhase(t, 110, 38, 0.22)) * Math.exp(-t * 11);
      const blast = boomLP(random() * 2 - 1) * Math.exp(-t * 22) * 1.4;
      const tail = tailLP(random() * 2 - 1) * Math.exp(-Math.max(0, t - 0.06) * 9) * 0.5;
      return boom * 1.2 + blast + tail;
    };
  });

  add('dryClick', 0.05, () => {
    const bp = bandpassish(2200, ctx.sampleRate);
    return (t) => bp(random() * 2 - 1) * Math.exp(-t * 160) * 2;
  });

  add('reloadClipOut', 0.07, () => metallicClick(ctx.sampleRate, 2600));
  add('reloadClipIn', 0.09, () => metallicClick(ctx.sampleRate, 1500));

  add('weaponSwitch', 0.12, () => {
    const first = metallicClick(ctx.sampleRate, 1900);
    const second = metallicClick(ctx.sampleRate, 1100);
    return (t) => first(t) + (t > 0.05 ? second(t - 0.05) : 0);
  });

  add('splat', 0.18, () => {
    const lp = onePole(900, ctx.sampleRate);
    return (t) => {
      const wet = lp(random() * 2 - 1) * Math.exp(-t * 34) * 1.5;
      const thump = Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t * 30) * 0.7;
      return wet + thump;
    };
  });

  add('ricochet', 0.16, () => {
    const bp = bandpassish(5000, ctx.sampleRate);
    return (t) => {
      const spark = bp(random() * 2 - 1) * Math.exp(-t * 70);
      const whine = Math.sin(sweepPhase(t, 3000, 1400, 0.12)) * Math.exp(-t * 28) * 0.4;
      return spark + whine;
    };
  });

  add('woodBreak', 0.3, () => {
    const knock = bandpassish(800, ctx.sampleRate);
    return (t) => {
      let value = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 30) * 0.8;
      for (const [offset, gain] of [[0, 1], [0.035, 0.7], [0.08, 0.5]] as const) {
        if (t >= offset) value += knock(random() * 2 - 1) * Math.exp(-(t - offset) * 60) * gain;
      }
      return value;
    };
  });

  add('hurt', 0.28, () => {
    const lp = onePole(500, ctx.sampleRate);
    return (t) => {
      const thump = Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t * 22);
      const vibrato = 1 + 0.06 * Math.sin(2 * Math.PI * 6 * t);
      const groan = lp(sawWave(115 * vibrato * t)) * Math.exp(-t * 12) * 0.9;
      return thump + groan;
    };
  });

  add('heartbeat', 0.36, () => (t) => {
    const beat = (offset: number) =>
      t >= offset ? Math.sin(2 * Math.PI * 55 * (t - offset)) * Math.exp(-(t - offset) * 34) : 0;
    return beat(0) + beat(0.17) * 0.8;
  });

  add('footstep', 0.07, () => {
    const lp = onePole(400, ctx.sampleRate);
    return (t) => lp(random() * 2 - 1) * Math.exp(-t * 70) * 2;
  });

  add('pickupHealth', 0.22, () => (t) => {
    const first = t < 0.1 ? Math.sin(2 * Math.PI * 660 * t) * Math.exp(-t * 18) : 0;
    const second = t >= 0.09 ? Math.sin(2 * Math.PI * 830 * (t - 0.09)) * Math.exp(-(t - 0.09) * 16) : 0;
    return (first + second) * 0.8;
  });

  add('pickupAmmo', 0.14, () => {
    const click = metallicClick(ctx.sampleRate, 2000);
    return (t) => click(t) * 0.7 + Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 28) * 0.8;
  });

  add('pickupShells', 0.16, () => {
    const click = metallicClick(ctx.sampleRate, 3000);
    const clink = metallicClick(ctx.sampleRate, 2400);
    return (t) => click(t) * 0.7 + (t > 0.06 ? clink(t - 0.06) * 0.6 : 0);
  });

  add('pickupArmor', 0.24, () => {
    const clink = metallicClick(ctx.sampleRate, 2800);
    return (t) => clink(t) * 0.8 + Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 14) * 0.5;
  });

  add('growl', 0.6, () => {
    const lp = onePole(700, ctx.sampleRate);
    return (t) => {
      const vibrato = 1 + 0.08 * Math.sin(2 * Math.PI * 5 * t);
      const tremolo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 9 * t);
      const envelope = Math.min(1, t * 14) * Math.exp(-t * 4.5);
      return lp(sawWave(88 * vibrato * t) + sawWave(132 * vibrato * t) * 0.5) * tremolo * envelope;
    };
  });

  add('enemyDeath', 0.45, () => {
    const lp = onePole(900, ctx.sampleRate);
    const splatLP = onePole(1100, ctx.sampleRate);
    return (t) => {
      const cry = lp(sawWave(sweepPhase(t, 160, 60, 0.3) / (2 * Math.PI))) * Math.exp(-t * 7);
      const splat = splatLP(random() * 2 - 1) * Math.exp(-t * 26) * 0.8;
      return cry + splat;
    };
  });

  add('bossBeat', 0.22, () => (t) => Math.sin(sweepPhase(t, 78, 42, 0.1)) * Math.exp(-t * 18) * 1.4);

  add('bossRoar', 1.2, () => {
    const lp = onePole(900, ctx.sampleRate);
    return (t) => {
      const drop = 1 - 0.3 * Math.min(1, t / 1.0);
      const stack = sawWave(55 * drop * t) + sawWave(82 * drop * t) * 0.8 + sawWave(110 * drop * t) * 0.6;
      const breath = (random() * 2 - 1) * 0.35;
      const envelope = Math.min(1, t * 9) * Math.exp(-Math.max(0, t - 0.5) * 3.2);
      const filterMod = 0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, t / 0.6));
      return lp((stack + breath) * filterMod) * envelope;
    };
  });

  add('whoosh', 0.28, () => {
    const bp = bandpassish(1200, ctx.sampleRate);
    return (t) => {
      const envelope = Math.sin(Math.PI * Math.min(1, t / 0.28));
      return bp(random() * 2 - 1) * envelope * 0.8;
    };
  });

  add('stingerWin', 1.0, () => (t) => {
    const notes: Array<[number, number]> = [[0, 392], [0.18, 494], [0.36, 587]];
    let value = 0;
    for (const [offset, freq] of notes) {
      if (t >= offset) {
        const local = t - offset;
        value += Math.sin(2 * Math.PI * freq * local) * Math.exp(-local * 4) * 0.6;
        value += Math.sin(2 * Math.PI * freq * 2 * local) * Math.exp(-local * 6) * 0.15;
      }
    }
    return value;
  });

  add('stingerLose', 1.1, () => {
    const lp = onePole(600, ctx.sampleRate);
    return (t) => {
      const envelope = Math.min(1, t * 8) * Math.exp(-t * 2.2);
      return lp(sawWave(98 * t) + sawWave(103.6 * t)) * envelope;
    };
  });

  add('uiClick', 0.03, () => {
    const bp = bandpassish(1800, ctx.sampleRate);
    return (t) => bp(random() * 2 - 1) * Math.exp(-t * 220) * 2;
  });

  return bank;
}

let seed = 0x9e3779b9;
function random() {
  // Deterministic PRNG keeps the bank identical between runs (and avoids Math.random in hot loops).
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
}

function render(ctx: BaseAudioContext, seconds: number, fill: Fill): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const value = fill(i / sampleRate);
    data[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  if (peak > 0) {
    const gain = 0.85 / peak;
    for (let i = 0; i < length; i += 1) data[i] *= gain;
  }
  // Short fade-out kills end-of-buffer clicks.
  const fade = Math.min(length, Math.floor(sampleRate * 0.008));
  for (let i = 0; i < fade; i += 1) data[length - 1 - i] *= i / fade;
  return buffer;
}

// Phase (radians) of a sine sweeping exponentially from f0 to f1 over `duration` seconds.
function sweepPhase(t: number, f0: number, f1: number, duration: number) {
  const k = Math.log(f1 / f0) / duration;
  if (Math.abs(k) < 1e-6) return 2 * Math.PI * f0 * t;
  const clamped = Math.min(t, duration);
  let phase = 2 * Math.PI * (f0 * (Math.exp(k * clamped) - 1)) / k;
  if (t > duration) phase += 2 * Math.PI * f1 * (t - duration);
  return phase;
}

function sawWave(cycles: number) {
  const fraction = cycles - Math.floor(cycles);
  return fraction * 2 - 1;
}

function onePole(cutoff: number, sampleRate: number) {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  let value = 0;
  return (x: number) => {
    value += k * (x - value);
    return value;
  };
}

// Cheap bandpass: lowpass minus a lower-cutoff lowpass.
function bandpassish(center: number, sampleRate: number) {
  const high = onePole(center * 1.4, sampleRate);
  const low = onePole(center * 0.6, sampleRate);
  return (x: number) => high(x) - low(x);
}

function metallicClick(sampleRate: number, freq: number): Fill {
  const bp = bandpassish(freq, sampleRate);
  return (t) => bp(random() * 2 - 1) * Math.exp(-t * 120) * 2 + Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 90) * 0.4;
}

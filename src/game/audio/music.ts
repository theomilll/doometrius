// Reactive ambient score: a dark two-chord drone (Dm <-> Eb) from detuned saws + sub sine,
// with sparse lowpassed percussion scheduled ahead of time. Intensity reacts to game state:
// 0 = exploring, 1 = boss fight, 2 = phase 3 / near death.

export type MusicIntensity = 0 | 1 | 2;

const BEAT_SECONDS = 1; // 60 BPM
const CHORD_BEATS = 8;
const LOOKAHEAD_SECONDS = 0.35;
const ROOTS = [73.42, 77.78]; // D2, Eb2

export class MusicEngine {
  private readonly output: GainNode;
  private readonly filter: BiquadFilterNode;
  private oscillators: OscillatorNode[] = [];
  private filterLfo: OscillatorNode | null = null;
  private thudBuffer: AudioBuffer;
  private tickBuffer: AudioBuffer;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  private beatIndex = 0;
  private intensity: MusicIntensity = 0;

  constructor(private readonly ctx: AudioContext, destination: AudioNode) {
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 480;
    this.filter.Q.value = 0.8;
    this.filter.connect(this.output);
    this.output.connect(destination);
    this.thudBuffer = renderPercussion(ctx, 0.22, 52, 26);
    this.tickBuffer = renderPercussion(ctx, 0.06, 900, 90);
  }

  start() {
    if (this.schedulerTimer) return;
    const now = this.ctx.currentTime;

    const detunes = [-4, 3];
    for (const detune of detunes) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = ROOTS[0];
      osc.detune.value = detune;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.16;
      osc.connect(gain);
      gain.connect(this.filter);
      osc.start(now);
      this.oscillators.push(osc);
    }
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = ROOTS[0] / 2;
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.4;
    sub.connect(subGain);
    subGain.connect(this.output);
    sub.start(now);
    this.oscillators.push(sub);

    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(this.filter.frequency);
    lfo.start(now);
    this.filterLfo = lfo;

    this.output.gain.linearRampToValueAtTime(1, now + 2.5);
    this.nextBeatTime = now + 0.1;
    this.beatIndex = 0;
    this.schedulerTimer = setInterval(() => this.schedule(), 100);
  }

  setIntensity(intensity: MusicIntensity) {
    if (intensity === this.intensity) return;
    this.intensity = intensity;
    const now = this.ctx.currentTime;
    this.filter.frequency.linearRampToValueAtTime(intensity === 2 ? 760 : intensity === 1 ? 600 : 480, now + 1.2);
  }

  stop() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.linearRampToValueAtTime(0, now + 0.8);
    for (const osc of this.oscillators) osc.stop(now + 1);
    this.filterLfo?.stop(now + 1);
    this.oscillators = [];
    this.filterLfo = null;
  }

  private schedule() {
    const horizon = this.ctx.currentTime + LOOKAHEAD_SECONDS;
    while (this.nextBeatTime < horizon) {
      this.scheduleBeat(this.nextBeatTime, this.beatIndex);
      this.beatIndex += 1;
      this.nextBeatTime += this.intensity === 2 ? BEAT_SECONDS / 2 : BEAT_SECONDS;
    }
  }

  private scheduleBeat(time: number, beat: number) {
    if (beat % CHORD_BEATS === 0) {
      const root = ROOTS[Math.floor(beat / CHORD_BEATS) % 2];
      for (const osc of this.oscillators.slice(0, 2)) {
        osc.frequency.linearRampToValueAtTime(root, time + 0.4);
      }
      this.oscillators[2]?.frequency.linearRampToValueAtTime(root / 2, time + 0.4);
    }
    if (beat % 2 === 0) this.playBuffer(this.thudBuffer, time, 0.8);
    if (this.intensity >= 1 && beat % 2 === 1) this.playBuffer(this.tickBuffer, time, 0.35);
  }

  private playBuffer(buffer: AudioBuffer, time: number, volume: number) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.output);
    source.start(time);
  }
}

function renderPercussion(ctx: BaseAudioContext, seconds: number, freq: number, decay: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(seconds * sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  let lowpass = 0;
  const k = 1 - Math.exp((-2 * Math.PI * freq * 2) / sampleRate);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    lowpass += k * ((Math.random() * 2 - 1) - lowpass);
    data[i] = (Math.sin(2 * Math.PI * freq * t) * 0.7 + lowpass * 0.6) * Math.exp(-t * decay) * 0.8;
  }
  return buffer;
}

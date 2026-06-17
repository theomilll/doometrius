export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0xffffffff;
  }

  range(min: number, max: number) {
    return min + (max - min) * this.next();
  }

  pick<T>(values: T[]) {
    return values[Math.floor(this.next() * values.length) % values.length];
  }
}

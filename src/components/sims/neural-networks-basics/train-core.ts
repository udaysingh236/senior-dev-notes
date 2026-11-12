// Pure training logic for the neural network sim (no DOM), so it can be tested on its own.
// Emails are points: x = links (0..1 scaled), y = money words (0..1 scaled).
// The hidden rule: an email is spam when it is far from the corner with few links and few
// money words (x² + y² ≥ 0.45), a curved border. A few labels are flipped, like real data.
// The network: 2 inputs -> H hidden ReLU neurons -> 1 sigmoid output. H = 0 means one neuron.

export interface CoreRng {
  next(): number;
}

export interface Email {
  x: number;
  y: number;
  spam: 0 | 1;
}

export const VALIDATION_SIZE = 60;
const NOISE = 0.05;

export function makeEmails(n: number, rng: CoreRng): Email[] {
  const out: Email[] = [];
  for (let i = 0; i < n; i++) {
    const x = rng.next();
    const y = rng.next();
    let spam: 0 | 1 = x * x + y * y >= 0.45 ? 1 : 0;
    if (rng.next() < NOISE) spam = spam ? 0 : 1;
    out.push({ x, y, spam });
  }
  return out;
}

export class Net {
  W: number[][]; // [hidden][2]
  bh: number[];
  V: number[]; // hidden -> output (or the 2 input weights when hidden = 0)
  bo = 0;
  readonly hidden: number;

  constructor(hidden: number, rng: CoreRng) {
    this.hidden = hidden;
    const r = () => (rng.next() * 2 - 1) * 1.5;
    this.W = Array.from({ length: hidden }, () => [r(), r()]);
    this.bh = Array.from({ length: hidden }, () => r() * 0.5);
    this.V = Array.from({ length: hidden || 2 }, () => r());
  }

  /** Inputs are centred so that 0..1 becomes -1..1, which makes training faster. */
  predict(px: number, py: number): number {
    const a = px * 2 - 1;
    const b = py * 2 - 1;
    let s = this.bo;
    if (this.hidden === 0) s += this.V[0] * a + this.V[1] * b;
    else
      for (let j = 0; j < this.hidden; j++) {
        const z = this.W[j][0] * a + this.W[j][1] * b + this.bh[j];
        if (z > 0) s += this.V[j] * z;
      }
    return 1 / (1 + Math.exp(-s));
  }

  /** One full pass over the training emails (one epoch) of gradient descent, averaged. */
  epoch(data: Email[], lr: number): void {
    const H = this.hidden;
    const gW = Array.from({ length: H }, () => [0, 0]);
    const gbh = new Array(H).fill(0);
    const gV = new Array(H || 2).fill(0);
    let gbo = 0;
    for (const e of data) {
      const a = e.x * 2 - 1;
      const b = e.y * 2 - 1;
      const z = new Array(H);
      let s = this.bo;
      if (H === 0) s += this.V[0] * a + this.V[1] * b;
      else
        for (let j = 0; j < H; j++) {
          z[j] = this.W[j][0] * a + this.W[j][1] * b + this.bh[j];
          if (z[j] > 0) s += this.V[j] * z[j];
        }
      const p = 1 / (1 + Math.exp(-s));
      const d = p - e.spam;
      gbo += d;
      if (H === 0) {
        gV[0] += d * a;
        gV[1] += d * b;
      } else
        for (let j = 0; j < H; j++) {
          if (z[j] <= 0) continue;
          gV[j] += d * z[j];
          const dh = d * this.V[j];
          gW[j][0] += dh * a;
          gW[j][1] += dh * b;
          gbh[j] += dh;
        }
    }
    const k = lr / data.length;
    this.bo -= k * gbo;
    for (let j = 0; j < gV.length; j++) this.V[j] -= k * gV[j];
    for (let j = 0; j < H; j++) {
      this.W[j][0] -= k * gW[j][0];
      this.W[j][1] -= k * gW[j][1];
      this.bh[j] -= k * gbh[j];
    }
  }

  loss(data: Email[]): number {
    let t = 0;
    for (const e of data) {
      const p = this.predict(e.x, e.y);
      t -= Math.log(Math.max(1e-9, e.spam ? p : 1 - p));
    }
    return t / data.length;
  }

  accuracy(data: Email[]): number {
    let right = 0;
    for (const e of data) if (this.predict(e.x, e.y) >= 0.5 === (e.spam === 1)) right++;
    return right / data.length;
  }
}

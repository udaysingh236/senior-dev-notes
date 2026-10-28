// The contract every topic simulation implements. See .claude/skills/add-topic/visuals.md.

/** A seeded random number generator. The same seed always gives the same sequence. */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** A random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Exponentially distributed float with the given mean (gaps between Poisson arrivals). */
  exponential(mean: number): number;
}

export interface ParamSpec {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  /** Text shown for a value instead of "value unit", e.g. (v) => (v === 0 ? 'off' : `${v} s`). */
  format?: (value: number) => string;
}

export interface SimModel {
  /** Rendered as sliders by the shell. Changing a slider calls reset() with the new values. */
  params: ParamSpec[];
  /** Rebuild state from scratch. Must depend only on params and rng, so Reset replays exactly. */
  reset(params: Record<string, number>, rng: Rng): void;
  /** Advance simulated time. The shell always passes the same fixed tick (see SimOptions.tickMs). */
  step(dtMs: number): void;
  /** Draw the current state into the shell's SVG. */
  render(view: SVGSVGElement): void;
  /** Live counters shown under the sim. */
  stats(): Record<string, string | number>;
  /** Latest event, e.g. "t=1.2s #14 rejected: bucket empty". */
  log?(): string | null;
  /** Extra buttons, e.g. "Send a burst of 20". The shell re-renders after each one runs. */
  actions?: { label: string; run(): void }[];
}

/**
 * Builds a model. `config` holds the JSON-serialisable props the page passed to the sim
 * component (for example `{ algorithm: 'token-bucket' }`).
 */
export type SimFactory = (config: Record<string, unknown>) => SimModel;

export interface SimOptions {
  /** Seed for the RNG. Default 42. */
  seed?: number;
  /** Simulated milliseconds per model step. Fixed so runs are identical at any frame rate. Default 20. */
  tickMs?: number;
  /** Simulated milliseconds the Step button advances. Default 100. */
  stepMs?: number;
  /** Start playing when first scrolled into view (never with reduced motion). Default true. */
  autoplay?: boolean;
}

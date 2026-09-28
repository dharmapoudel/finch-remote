// Frame-rate independent animation primitives + a single shared rAF loop.
// Pure TypeScript: no React, no network. All step() functions take dt in
// seconds so behavior is independent of frame rate.

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
  epsilon?: number;
}

/** Damped spring integrated with semi-implicit Euler. */
export class Spring {
  x: number;
  v: number;
  target: number;
  private k: number;
  private c: number;
  private m: number;
  private eps: number;

  constructor(cfg: SpringConfig) {
    this.k = cfg.stiffness;
    this.c = cfg.damping;
    this.m = cfg.mass ?? 1;
    this.eps = cfg.epsilon ?? 0.01;
    this.x = 0;
    this.v = 0;
    this.target = 0;
  }

  configure(cfg: Partial<SpringConfig>): void {
    if (cfg.stiffness !== undefined) this.k = cfg.stiffness;
    if (cfg.damping !== undefined) this.c = cfg.damping;
    if (cfg.mass !== undefined) this.m = cfg.mass;
    if (cfg.epsilon !== undefined) this.eps = cfg.epsilon;
  }

  /** Hard-set position (and target), zeroing velocity. */
  snap(x: number): void {
    this.x = x;
    this.target = x;
    this.v = 0;
  }

  /**
   * Advance the spring by dt seconds (semi-implicit Euler).
   * Returns true when settled (|x - target| < eps && |v| < eps),
   * snapping x exactly to target and v to 0 on settle.
   */
  step(dt: number): boolean {
    const acc = (this.k * (this.target - this.x) - this.c * this.v) / this.m;
    this.v += acc * dt;
    this.x += this.v * dt;
    if (Math.abs(this.x - this.target) < this.eps && Math.abs(this.v) < this.eps) {
      this.x = this.target;
      this.v = 0;
      return true;
    }
    return false;
  }
}

/** Free-rolling value with exponential velocity decay. */
export class Inertia {
  x: number;
  v: number;
  friction: number;

  constructor(friction?: number) {
    this.friction = friction ?? 5;
    this.x = 0;
    this.v = 0;
  }

  impulse(dv: number): void {
    this.v += dv;
  }

  step(dt: number): void {
    this.v *= Math.exp(-this.friction * dt);
    this.x += this.v * dt;
  }
}

export type TickFn = (dt: number, nowMs: number) => boolean | void;

/** Return false from a TickFn to unsubscribe it. */
export function addTick(fn: TickFn): () => void {
  let active = true;
  const wrapped = (dt: number, nowMs: number): boolean | void => {
    if (!active) return false;
    return fn(dt, nowMs);
  };
  subscribers.add(wrapped);
  ensureLoop();
  return () => {
    active = false;
    subscribers.delete(wrapped);
  };
}

const subscribers = new Set<(dt: number, nowMs: number) => boolean | void>();

let rafId: number | null = null;
let last = 0;

function loop(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  for (const fn of [...subscribers]) {
    try {
      if (fn(dt, now) === false) subscribers.delete(fn);
    } catch {
      // A failing subscriber must not kill the shared loop.
    }
  }
  rafId = subscribers.size > 0 ? requestAnimationFrame(loop) : null;
}

/** Starts the single shared rAF loop. Idempotent. */
export function ensureLoop(): void {
  if (rafId !== null) return;
  if (subscribers.size === 0) return;
  last = performance.now();
  rafId = requestAnimationFrame(loop);
}

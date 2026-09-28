// Hardware input layer for the Car Thing knob.
// - Rotate arrives as window `wheel` events: one detent per ~40px of
//   accumulated dominant-axis delta, with preventDefault({passive:false})
//   so the page never scrolls natively.
// - Press arrives as `Enter` keydown/keyup: tap = press <600ms,
//   hold = press >=600ms. A single physical press can emit TWO key event
//   pairs, so keyup is debounced (ignore if <350ms since last handled one).
// - When the user is typing (focus in INPUT/TEXTAREA/SELECT or
//   contentEditable), Enter is left alone entirely.
// Pure TypeScript: no React, no network.

export type KnobMode = 'scroll' | 'scrub' | 'volume';

/** One detent of knob rotation. velocity = signed detents/sec over the trailing 300ms. */
export interface Detent {
  dir: 1 | -1;
  velocity: number;
}

export type DetentFn = (d: Detent) => void;

const DETENT_PX = 40;
const TAP_MS = 600;
const DEBOUNCE_MS = 350;
const VELOCITY_WINDOW_MS = 300;

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // One bad subscriber must not kill input.
  }
}

function safeDetent(fn: DetentFn, d: Detent): void {
  try {
    fn(d);
  } catch {
    // One bad subscriber must not kill input.
  }
}

export class KnobEngine {
  mode: KnobMode = 'scroll';

  private detentSubs = new Set<DetentFn>();
  private tapSubs = new Set<() => void>();
  private holdSubs = new Set<() => void>();

  private attached = false;
  private acc = 0;
  private detentTimes: number[] = [];

  private pressStart: number | null = null;
  private holdTimer: number | null = null;
  private holdFired = false;
  private lastHandled = 0;

  onDetent(fn: DetentFn): () => void {
    this.detentSubs.add(fn);
    return () => {
      this.detentSubs.delete(fn);
    };
  }

  onTap(fn: () => void): () => void {
    this.tapSubs.add(fn);
    return () => {
      this.tapSubs.delete(fn);
    };
  }

  onHold(fn: () => void): () => void {
    this.holdSubs.add(fn);
    return () => {
      this.holdSubs.delete(fn);
    };
  }

  /** Sets the mode; consumers manage transitions themselves. */
  setMode(m: KnobMode): void {
    this.mode = m;
  }

  isTyping(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return true;
    }
    return (el as HTMLElement).isContentEditable;
  }

  /** Idempotent. Hooks window wheel (capture, passive:false) + Enter keydown/keyup (capture). */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
    window.addEventListener('keydown', this.handleKeyDown, { capture: true });
    window.addEventListener('keyup', this.handleKeyUp, { capture: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('wheel', this.handleWheel, { capture: true });
    window.removeEventListener('keydown', this.handleKeyDown, { capture: true });
    window.removeEventListener('keyup', this.handleKeyUp, { capture: true });
    this.clearHoldTimer();
    this.pressStart = null;
    this.holdFired = false;
  }

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dominant = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.acc += dominant;
    while (Math.abs(this.acc) >= DETENT_PX) {
      const dir: 1 | -1 = this.acc > 0 ? 1 : -1;
      this.acc -= dir * DETENT_PX;
      this.emitDetent(dir);
    }
  };

  private emitDetent(dir: 1 | -1): void {
    const now = performance.now();
    this.detentTimes.push(now);
    const cutoff = now - VELOCITY_WINDOW_MS;
    while (this.detentTimes.length > 0 && this.detentTimes[0] < cutoff) {
      this.detentTimes.shift();
    }
    // Single detent in the window counts as dir * (1 / 0.3) detents/sec.
    const velocity = (dir * this.detentTimes.length) / (VELOCITY_WINDOW_MS / 1000);
    const d: Detent = { dir, velocity };
    for (const fn of [...this.detentSubs]) safeDetent(fn, d);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    if (this.isTyping()) return; // no preventDefault, no events while typing
    if (e.repeat) return;
    e.preventDefault();
    if (this.pressStart !== null) return; // already tracking a press
    this.pressStart = performance.now();
    this.holdFired = false;
    this.holdTimer = window.setTimeout(() => {
      // Fires at >=600ms while still held, once per press.
      if (this.pressStart !== null && !this.holdFired) {
        this.holdFired = true;
        for (const fn of [...this.holdSubs]) safeCall(fn);
      }
    }, TAP_MS);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    if (this.isTyping()) return;
    if (this.pressStart === null) return;
    const now = performance.now();
    this.clearHoldTimer();
    const wasHold = this.holdFired;
    this.pressStart = null;
    this.holdFired = false;
    // Debounce the double key-event pairs a single physical press can emit.
    if (now - this.lastHandled < DEBOUNCE_MS) return;
    if (wasHold) {
      this.lastHandled = now; // hold-release counts as a handled press
      return; // hold already fired; no tap
    }
    this.lastHandled = now;
    for (const fn of [...this.tapSubs]) safeCall(fn);
  };

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

export const knob = new KnobEngine();

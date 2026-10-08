// Hardware input layer for the Car Thing knob.
// - Rotate arrives as window `wheel` events. A physical knob click arrives
//   as a BURST of wheel events; a burst that starts after BURST_GAP_MS of
//   quiet is exactly one physical click, so it emits exactly one detent no
//   matter how many px the device reports per click. (The old fixed 40px
//   threshold made single clicks dead or double on devices whose
//   px-per-click differs from the guess.) Within a burst (fast spins),
//   extra detents fire per pxPerClick, which self-calibrates from isolated
//   single-click bursts and persists across sessions.
// - Press arrives as `Enter` keydown/keyup: tap = press <600ms,
//   hold = press >=600ms. A single physical press can emit TWO key event
//   pairs, so keyup is debounced (ignore if <350ms since last handled one).
// - When the user is typing (focus in INPUT/TEXTAREA/SELECT or
//   contentEditable), Enter is left alone entirely.
// Pure TypeScript: no React, no network.

export type KnobMode = 'scroll' | 'nowplaying' | 'volume';

/** One detent of knob rotation. velocity = signed detents/sec over the trailing 300ms. */
export interface Detent {
  dir: 1 | -1;
  velocity: number;
}

export type DetentFn = (d: Detent) => void;

const TAP_MS = 600;
const DEBOUNCE_MS = 350;
const VELOCITY_WINDOW_MS = 300;

// ---- burst-based detent detection ----
const BURST_GAP_MS = 120; // quiet longer than this => next events are a new physical click
const PX_PER_CLICK_INIT = 40; // cold-start guess until calibration kicks in
const PX_PER_CLICK_MIN = 8;
const PX_PER_CLICK_MAX = 120;
const CALIBRATION_ALPHA = 0.35; // EMA weight per isolated single-click burst
const PX_PER_CLICK_KEY = 'finch:pxPerClick';

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
  private detentTimes: number[] = [];
  private detentCount = 0;

  // Burst state for detent detection.
  private pxPerClick = KnobEngine.loadPxPerClick();
  private burstActive = false;
  private burstPx = 0;
  private burstDir: 1 | -1 = 1;
  private burstDetents = 0;
  private burstIsolated = false;
  private lastEventTime = 0;

  private pressStart: number | null = null;
  private holdTimer: number | null = null;
  private holdFired = false;
  private lastHandled = 0;

  private static loadPxPerClick(): number {
    try {
      if (typeof window === 'undefined') return PX_PER_CLICK_INIT;
      const raw = window.localStorage.getItem(PX_PER_CLICK_KEY);
      const v = raw === null ? NaN : Number(raw);
      if (Number.isFinite(v) && v >= PX_PER_CLICK_MIN && v <= PX_PER_CLICK_MAX) return v;
    } catch {
      // Storage unavailable (private mode, etc.) — fall back to the guess.
    }
    return PX_PER_CLICK_INIT;
  }

  private savePxPerClick(): void {
    try {
      window.localStorage.setItem(PX_PER_CLICK_KEY, String(Math.round(this.pxPerClick * 10) / 10));
    } catch {
      // Non-fatal.
    }
  }

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

  /** Read-only diagnostics snapshot (headless QA; no user data). */
  debugState(): { pxPerClick: number; detents: number; mode: KnobMode } {
    return {
      pxPerClick: Math.round(this.pxPerClick * 10) / 10,
      detents: this.detentCount,
      mode: this.mode,
    };
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
    if (dominant === 0) return;
    const now = performance.now();
    const dir: 1 | -1 = dominant > 0 ? 1 : -1;
    const gap = now - this.lastEventTime;
    this.lastEventTime = now;

    if (!this.burstActive || gap > BURST_GAP_MS) {
      // New physical click: fold the previous burst into calibration, then
      // emit exactly one detent for this click regardless of px.
      this.endBurst();
      this.burstActive = true;
      this.burstPx = Math.abs(dominant);
      this.burstDir = dir;
      this.burstDetents = 1;
      this.burstIsolated = gap > BURST_GAP_MS;
      this.emitDetent(dir);
    } else if (dir !== this.burstDir) {
      // Direction reversed mid-burst: a deliberate change, treat as a new
      // click. Not calibration signal (it wasn't preceded by quiet).
      this.endBurst();
      this.burstActive = true;
      this.burstPx = Math.abs(dominant);
      this.burstDir = dir;
      this.burstDetents = 1;
      this.burstIsolated = false;
      this.emitDetent(dir);
    } else {
      this.burstPx += Math.abs(dominant);
      // Fast spin: pace extra detents by the calibrated px-per-click.
      // The first detent was free at burst start, so count starts at 1.
      const owed = Math.max(1, Math.round(this.burstPx / this.pxPerClick));
      while (this.burstDetents < owed) {
        this.emitDetent(dir);
        this.burstDetents++;
      }
    }
  };

  /**
   * Fold a finished burst into the px-per-click calibration. Only isolated
   * single-detent bursts carry signal: their detent came from the "one
   * burst = one click" rule, not from px math, so burstPx IS the device's
   * true px-per-click.
   */
  private endBurst(): void {
    if (!this.burstActive) return;
    this.burstActive = false;
    if (
      this.burstIsolated &&
      this.burstDetents === 1 &&
      this.burstPx >= PX_PER_CLICK_MIN &&
      this.burstPx <= PX_PER_CLICK_MAX * 1.6
    ) {
      const sample = Math.max(PX_PER_CLICK_MIN, Math.min(PX_PER_CLICK_MAX, this.burstPx));
      this.pxPerClick += CALIBRATION_ALPHA * (sample - this.pxPerClick);
      this.savePxPerClick();
    }
    this.burstIsolated = false;
  }

  private emitDetent(dir: 1 | -1): void {
    const now = performance.now();
    this.detentTimes.push(now);
    this.detentCount++;
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

// Read-only diagnostics hook for headless QA (no user data exposed).
if (typeof window !== 'undefined') {
  (window as unknown as { __finchKnob?: () => unknown }).__finchKnob = () => knob.debugState();
}

// Knob focus system: a physics-driven focus ring that glides between
// [data-focusable] elements inside the active FocusScope.
//
// Interaction model:
// - LOGICAL position is integer-exact: every knob detent moves it by exactly
//   one item, always. The spring below only affects how the ring *looks*
//   getting there, so one physical click can never land two items away (or
//   nowhere) no matter the frame timing or leftover velocity.
// - The VISUAL ring position chases the logical index with a spring; fast
//   spins inject velocity so the ring glides with momentum, then the spring
//   settles it exactly onto the logical item with a magnetic snap.
// - The spring stiffens while music is playing (intentPlaying), so the
//   focus feels tighter during playback.
// - One fixed-position ring div lerps between the two nearest item rects.
// - While knob-driving, the nearest scrollable ancestor is eased with a
//   critically-damped spring so the focused item stays centered; the
//   spring is released 800ms after the last detent so touch scroll is
//   never fought.

import { useEffect, useRef } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { Spring, addTick, ensureLoop } from './physics';
import { knob } from './knob';
import { player } from '../player';

// ---- tuning constants ----
const END_OVERSHOOT = 0.5; // ring may travel this far (in items) past each end
const DRIVE_WINDOW_MS = 800; // scroll follow stays engaged this long after the last detent
const SCROLL_STIFFNESS = 140; // scroll follow spring (damping ~= 2*sqrt(140): critical)
const SCROLL_DAMPING = 23.6;
const SCROLL_OVERSHOOT_PX = 28; // rail beyond scroll bounds; the spring pulls back
const SPRING_PLAYING = { stiffness: 260, damping: 27 };
const SPRING_IDLE = { stiffness: 170, damping: 21 };
// Visual fling kick per detent (items/sec): fast spins throw the ring ahead
// so it glides; the spring always settles back onto the logical index.
const KICK_BASE = 2;
const KICK_VEL = 0.35;
const KICK_VEL_MAX = 25;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type Motion = 'idle' | 'settle';

export class FocusManager {
  private stack: Array<HTMLElement | null> = [];
  private items: HTMLElement[] = [];
  private logical = 0; // the item the user asked for: ALWAYS integer-exact
  private pos = 0; // visual ring position (items, float), spring-chased
  private motion: Motion = 'idle';
  private settleSpring = new Spring({ stiffness: 170, damping: 21 });
  private scrollXSpring = new Spring({ stiffness: SCROLL_STIFFNESS, damping: SCROLL_DAMPING });
  private scrollYSpring = new Spring({ stiffness: SCROLL_STIFFNESS, damping: SCROLL_DAMPING });
  private driving = false;
  private driveTimer: number | null = null;
  private ring: HTMLDivElement | null = null;
  private ringW = -1;
  private ringH = -1;
  private attached = false;
  private detentUnsub: (() => void) | null = null;
  private tickUnsub: (() => void) | null = null;

  get count(): number {
    return this.items.length;
  }

  get settledIndex(): number {
    return this.count === 0 ? 0 : clamp(Math.round(this.logical), 0, this.count - 1);
  }

  /** Read-only diagnostics snapshot (headless QA; no user data). */
  debugState(): { logical: number; pos: number; settled: number; count: number; motion: Motion } {
    return {
      logical: Math.round(this.logical * 100) / 100,
      pos: Math.round(this.pos * 100) / 100,
      settled: this.settledIndex,
      count: this.count,
      motion: this.motion,
    };
  }

  // ---- scopes ----

  pushScope(el: HTMLElement | null): void {
    if (this.stack.length > 0 && this.stack[this.stack.length - 1] === el) return;
    this.stack.push(el);
    this.afterScopeChange();
  }

  popScope(el: HTMLElement | null): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i] === el) {
        this.stack.splice(i, 1);
        this.afterScopeChange();
        return;
      }
    }
  }

  private activeScope(): HTMLElement | null | undefined {
    return this.stack.length === 0 ? undefined : this.stack[this.stack.length - 1];
  }

  private afterScopeChange(): void {
    this.refresh();
    this.reset();
  }

  // ---- items ----

  /** Re-query [data-focusable] in the active scope, DOM order. */
  refresh(): void {
    const scope = this.activeScope();
    if (scope === undefined) {
      this.items = [];
      this.logical = 0;
      this.pos = 0;
      this.motion = 'idle';
    } else {
      const root: ParentNode = scope ?? document;
      const found = root.querySelectorAll('[data-focusable]');
      const items: HTMLElement[] = [];
      found.forEach((n) => {
        if (n instanceof HTMLElement && FocusManager.isUsable(n)) items.push(n);
      });
      this.items = items;
      if (this.count === 0) {
        this.logical = 0;
        this.pos = 0;
        this.motion = 'idle';
      } else {
        // Keep the logical index valid across list updates; the spring
        // glides the ring to wherever it lands.
        this.logical = clamp(this.logical, 0, this.count - 1);
      }
    }
    this.updateRingVisibility();
    this.updateRing();
  }

  private static isUsable(el: HTMLElement): boolean {
    if ((el as unknown as { disabled?: unknown }).disabled === true) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    // offsetParent is null for display:none descendants; position:fixed
    // elements also report null, so exempt them via computed style.
    if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
    return true;
  }

  /** Snap to [data-focus-default] if present, else index 0. */
  reset(): void {
    let idx = 0;
    if (this.count > 0) {
      const def = this.items.findIndex((el) => el.hasAttribute('data-focus-default'));
      idx = def >= 0 ? def : 0;
    }
    this.logical = idx;
    this.pos = idx;
    this.motion = 'idle';
    this.settleSpring.snap(idx);
    this.updateRingVisibility();
    this.updateRing();
  }

  // ---- motion ----

  move(dir: 1 | -1, velocity: number): void {
    if (this.count === 0) return;
    // Logical: exactly one item per detent, always. This is the user's
    // intent and the ONLY thing that decides where focus settles.
    this.logical = clamp(Math.round(this.logical) + dir, 0, this.count - 1);
    // Visual: throw the ring ahead on fast spins so it glides with
    // momentum. The spring always settles back onto `logical`.
    this.settleSpring.v += dir * (KICK_BASE + Math.min(Math.abs(velocity), KICK_VEL_MAX) * KICK_VEL);
    this.motion = 'settle';
    this.driving = true;
    if (this.driveTimer !== null) window.clearTimeout(this.driveTimer);
    this.driveTimer = window.setTimeout(() => {
      this.driveTimer = null;
      this.driving = false;
    }, DRIVE_WINDOW_MS);
    this.ensureTick();
  }

  /** Click the settled item. No-op while typing or when empty. */
  activate(): void {
    if (knob.isTyping()) return;
    const el = this.items[this.settledIndex];
    if (el) el.click();
  }

  // ---- lifecycle ----

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    ensureLoop();
    this.ensureRing();
    this.detentUnsub = knob.onDetent((d) => {
      if (knob.mode !== 'scroll' || knob.isTyping()) return;
      this.move(d.dir, d.velocity);
    });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (this.detentUnsub !== null) {
      this.detentUnsub();
      this.detentUnsub = null;
    }
    if (this.tickUnsub !== null) {
      this.tickUnsub();
      this.tickUnsub = null;
    }
    if (this.driveTimer !== null) {
      window.clearTimeout(this.driveTimer);
      this.driveTimer = null;
    }
    this.driving = false;
    if (this.ring !== null) {
      this.ring.remove();
      this.ring = null;
    }
    this.ringW = -1;
    this.ringH = -1;
  }

  private ensureTick(): void {
    if (this.tickUnsub === null) this.tickUnsub = addTick(this.onTick);
  }

  private onTick = (dt: number, _nowMs: number): boolean => {
    dt = Math.min(dt, 0.05);
    const n = this.count;
    // Adaptive magnetic detents: stiffer snap while music is playing.
    this.settleSpring.configure(player.intentPlaying ? SPRING_PLAYING : SPRING_IDLE);
    if (n > 0) {
      this.logical = clamp(this.logical, 0, n - 1);
      this.settleSpring.target = this.logical;
      if (this.motion === 'settle') {
        if (this.settleSpring.step(dt)) {
          // Settled EXACTLY on the logical index: one click in, one item moved.
          this.pos = this.settleSpring.target;
          this.motion = 'idle';
          this.fireLanded(this.settledIndex);
        } else {
          this.pos = this.settleSpring.x;
        }
      }
      this.pos = clamp(this.pos, -END_OVERSHOOT, n - 1 + END_OVERSHOOT);
      this.updateRing();
      this.updateScroll(dt);
    }
    // Returning false unsubscribes from the shared loop; move() re-adds.
    const busy = this.motion !== 'idle' || this.driving;
    if (!busy) {
      this.tickUnsub = null;
      return false;
    }
    return true;
  };

  private fireLanded(index: number): void {
    const el = this.items[index];
    if (el) {
      el.classList.remove('fx-item-pop');
      void el.offsetWidth; // force reflow so the animation retriggers
      el.classList.add('fx-item-pop');
    }
    if (this.ring !== null) {
      this.ring.classList.remove('fx-ring-pop');
      void this.ring.offsetWidth;
      this.ring.classList.add('fx-ring-pop');
    }
  }

  // ---- ring ----

  private ensureRing(): HTMLDivElement {
    if (this.ring === null) {
      const d = document.createElement('div');
      d.className = 'fx-focus-ring';
      d.style.position = 'fixed';
      d.style.left = '0';
      d.style.top = '0';
      d.style.pointerEvents = 'none';
      d.style.zIndex = '90';
      d.style.display = 'none';
      document.body.appendChild(d);
      this.ring = d;
    }
    return this.ring;
  }

  private updateRingVisibility(): void {
    if (this.ring === null) return;
    this.ring.style.display = this.stack.length > 0 && this.count > 0 ? '' : 'none';
  }

  private updateRing(): void {
    const ring = this.ring;
    if (ring === null || this.stack.length === 0 || this.count === 0) return;
    const n = this.count;
    const lo = clamp(Math.floor(this.pos), 0, n - 1);
    const hi = clamp(Math.ceil(this.pos), 0, n - 1);
    const a = this.items[lo].getBoundingClientRect();
    const b = this.items[hi].getBoundingClientRect();
    const t = clamp(this.pos - Math.floor(this.pos), 0, 1);
    const x = a.left + (b.left - a.left) * t;
    const y = a.top + (b.top - a.top) * t;
    const w = a.width + (b.width - a.width) * t;
    const h = a.height + (b.height - a.height) * t;
    ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (w !== this.ringW || h !== this.ringH) {
      this.ringW = w;
      this.ringH = h;
      ring.style.width = `${w}px`;
      ring.style.height = `${h}px`;
    }
  }

  // ---- scroll follow ----

  private nearestScrollable(from: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = from.parentElement;
    while (el !== null) {
      if (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4) return el;
      el = el.parentElement;
    }
    return null;
  }

  private updateScroll(dt: number): void {
    const n = this.count;
    if (n === 0) return;
    const item = this.items[clamp(Math.round(this.pos), 0, n - 1)];
    const scroller = item ? this.nearestScrollable(item) : null;
    if (scroller === null) return;
    if (!this.driving) {
      // Stay glued to the real scroll position so engaging the spring
      // never jumps; we never write scroll while not knob-driving.
      this.scrollYSpring.snap(scroller.scrollTop);
      this.scrollXSpring.snap(scroller.scrollLeft);
      return;
    }
    const cRect = scroller.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    if (scroller.scrollHeight > scroller.clientHeight + 4) {
      const max = scroller.scrollHeight - scroller.clientHeight;
      this.scrollYSpring.target = clamp(
        scroller.scrollTop + (iRect.top + iRect.height / 2) - (cRect.top + cRect.height / 2),
        0,
        max,
      );
      this.scrollYSpring.step(dt);
      this.scrollYSpring.x = clamp(this.scrollYSpring.x, -SCROLL_OVERSHOOT_PX, max + SCROLL_OVERSHOOT_PX);
      scroller.scrollTop = this.scrollYSpring.x;
    }
    if (scroller.scrollWidth > scroller.clientWidth + 4) {
      const max = scroller.scrollWidth - scroller.clientWidth;
      this.scrollXSpring.target = clamp(
        scroller.scrollLeft + (iRect.left + iRect.width / 2) - (cRect.left + cRect.width / 2),
        0,
        max,
      );
      this.scrollXSpring.step(dt);
      this.scrollXSpring.x = clamp(this.scrollXSpring.x, -SCROLL_OVERSHOOT_PX, max + SCROLL_OVERSHOOT_PX);
      scroller.scrollLeft = this.scrollXSpring.x;
    }
  }
}

export const focusManager = new FocusManager();

export function FocusScope({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    focusManager.pushScope(el);
    focusManager.refresh();
    // View content often arrives asynchronously (rails, search results):
    // re-query on subtree changes so the item list never goes stale.
    // (Class toggles are excluded: the landed-pop animation must not loop.)
    let timer: number | null = null;
    const mo = new MutationObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        focusManager.refresh();
      }, 60);
    });
    if (el !== null) {
      mo.observe(el, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-focusable', 'disabled', 'aria-disabled'],
      });
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      mo.disconnect();
      focusManager.popScope(el);
    };
  }, []);
  // Re-query after every render so added/removed/reshown items are picked up.
  useEffect(() => {
    focusManager.refresh();
  });
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

// Read-only diagnostics hook for headless QA (no user data exposed).
if (typeof window !== 'undefined') {
  (window as unknown as { __finchFocus?: () => unknown }).__finchFocus = () =>
    focusManager.debugState();
}

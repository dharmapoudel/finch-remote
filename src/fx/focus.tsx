// Knob focus system: exact 1:1 focus movement through [data-focusable]
// elements inside the active FocusScope.
//
// Interaction model:
// - LOGICAL position is integer-exact: every knob detent moves it by exactly
//   one item, always. There is no visual offset, no spring, no momentum —
//   one physical click lands exactly one item away, synchronously.
// - The focused item carries a subtle persistent glow (.fx-focus-glow). No
//   cursor, no ring, no animation: the class simply moves between items, so
//   nothing on screen ever moves except the glow itself.
// - The settled item is kept visible with a native smooth scrollIntoView
//   (block: 'nearest'), so the browser compositor does the scrolling — no
//   per-frame JS, no forced layouts on the hot path.
// - The top tab bar is not part of the focus order, and the whole system
//   suspends on the Now Playing screen (the knob drives volume there instead).

import { useEffect, useRef } from 'react';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { knob } from './knob';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class FocusManager {
  private stack: Array<HTMLElement | null> = [];
  private items: HTMLElement[] = [];
  private logical = 0; // the focused item: ALWAYS integer-exact
  private suspended = false;
  private glowEl: HTMLElement | null = null;
  private attached = false;
  private detentUnsub: (() => void) | null = null;

  get count(): number {
    return this.items.length;
  }

  get settledIndex(): number {
    return this.count === 0 ? 0 : clamp(Math.round(this.logical), 0, this.count - 1);
  }

  /** Read-only diagnostics snapshot (headless QA; no user data). */
  debugState(): {
    logical: number;
    pos: number;
    settled: number;
    count: number;
    motion: 'idle';
    suspended: boolean;
  } {
    return {
      logical: Math.round(this.logical * 100) / 100,
      pos: this.settledIndex,
      settled: this.settledIndex,
      count: this.count,
      motion: 'idle',
      suspended: this.suspended,
    };
  }

  /**
   * Screens without a focus order (Now Playing: the knob drives volume
   * there) suspend the system entirely: no items, no glow, detents ignored.
   */
  setSuspended(s: boolean): void {
    if (this.suspended === s) return;
    this.suspended = s;
    if (s) {
      this.items = [];
      this.clearGlow();
    }
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
    if (this.suspended) {
      this.items = [];
      this.clearGlow();
      return;
    }
    const scope = this.activeScope();
    if (scope === undefined) {
      this.items = [];
      this.logical = 0;
    } else {
      const root: ParentNode = scope ?? document;
      const found = root.querySelectorAll('[data-focusable]');
      const items: HTMLElement[] = [];
      found.forEach((n) => {
        if (n instanceof HTMLElement && FocusManager.isUsable(n)) items.push(n);
      });
      this.items = items;
      // Keep the logical index valid across list updates; the glow follows.
      this.logical = clamp(this.logical, 0, Math.max(0, this.count - 1));
      if (this.count === 0) this.logical = 0;
    }
    this.applyGlow();
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
    this.applyGlow();
  }

  // ---- motion ----

  /**
   * Exactly one item per detent, applied synchronously: the glow moves and
   * the item is scrolled into view. No animation loop, no per-frame work.
   */
  move(dir: 1 | -1): void {
    if (this.count === 0 || this.suspended) return;
    // Logical: exactly one item per detent, always. This is the user's
    // intent and the ONLY thing that decides where focus lands.
    this.logical = clamp(Math.round(this.logical) + dir, 0, this.count - 1);
    this.applyGlow();
    // Native smooth scroll, and only when the item isn't already visible —
    // the browser moves the list, not per-frame JS.
    const el = this.items[this.settledIndex];
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Click the settled item. No-op while typing or when empty. */
  activate(): void {
    if (knob.isTyping()) return;
    const el = this.items[this.settledIndex];
    if (el) el.click();
  }

  // ---- glow ----

  /**
   * Where the glow lands for the focused item:
   * - default: the box itself (.fx-focus-glow);
   * - a [data-glow-target] descendant: the glow moves onto it (tiles and
   *   cards: the artwork squircle, not the whole tile);
   * - data-glow="text": the text itself glows (.fx-focus-glow-text);
   * - data-glow="none": no visual at all (invisible backdrops).
   */
  private glowTarget(el: HTMLElement): HTMLElement | null {
    if (el.getAttribute('data-glow') === 'none') return null;
    const t = el.querySelector('[data-glow-target]');
    return t instanceof HTMLElement ? t : el;
  }

  private glowClass(el: HTMLElement): string {
    const t = el.querySelector('[data-glow-target]');
    const host = t instanceof HTMLElement ? t : el;
    const kind = host.getAttribute('data-glow') ?? el.getAttribute('data-glow');
    return kind === 'text' ? 'fx-focus-glow-text' : 'fx-focus-glow';
  }

  private applyGlow(): void {
    const el =
      this.count > 0 && !this.suspended ? (this.items[this.settledIndex] ?? null) : null;
    const target = el !== null ? this.glowTarget(el) : null;
    if (this.glowEl === target) return;
    this.clearGlow();
    if (target !== null && el !== null) {
      target.classList.add(this.glowClass(el));
      this.glowEl = target;
    }
  }

  private clearGlow(): void {
    if (this.glowEl !== null) {
      this.glowEl.classList.remove('fx-focus-glow', 'fx-focus-glow-text');
      this.glowEl = null;
    }
  }

  // ---- lifecycle ----

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.detentUnsub = knob.onDetent((d) => {
      if (knob.mode !== 'scroll' || knob.isTyping() || this.suspended) return;
      this.move(d.dir);
    });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (this.detentUnsub !== null) {
      this.detentUnsub();
      this.detentUnsub = null;
    }
    this.clearGlow();
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

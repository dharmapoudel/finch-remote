// Knob focus system: exact 1:1 focus movement through [data-focusable]
// elements inside the active FocusScope.
//
// Interaction model:
// - LOGICAL position is integer-exact: every knob detent moves it by exactly
//   one item, always. There is no visual offset, no spring, no momentum —
//   one physical click lands exactly one item away, synchronously.
// - The focused item is marked by Finch 1.3.1's gliding selection highlight
//   (one .fx-sel element per scroll container, transform-only glide).
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
  private attached = false;
  private detentUnsub: (() => void) | null = null;
  // The glow only appears after the user turns the knob: a fresh view shows
  // no focus indicator at all until the first detent.
  private touched = false;

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

  /** Snap to [data-focus-default] if present, else index 0. The glow stays
   * hidden until the first knob turn (touched resets on every scope change). */
  reset(): void {
    let idx = 0;
    if (this.count > 0) {
      const def = this.items.findIndex((el) => el.hasAttribute('data-focus-default'));
      idx = def >= 0 ? def : 0;
    }
    this.logical = idx;
    this.touched = false;
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
    // First knob turn reveals the glow; until then the view shows none.
    this.touched = true;
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

  // ---- selection indicator (Finch 1.3.1's SelectList highlight) ----
  //
  // 1.4.0 kept finch-remote's invisible "glow" class, so turning the knob
  // showed nothing. 1.4.1 brings back 1.3.1's indicator: ONE highlight
  // element per scroll container that glides to the selected item with a
  // 300 ms transform transition (1.3.1's ease-out), tinted panel + hairline
  // ring + accent bar on the left for rows, an accent ring around the art
  // for tiles, a ring for round buttons. Only its transform animates; its
  // size is set once per move. The selected item also gets .fx-sel-on, which
  // nudges its .sel-shift content right as 1.3.1's rows did.

  private ind: HTMLDivElement | null = null;
  private selEl: HTMLElement | null = null;

  /** Where the indicator lives: the item's scroll container (so it scrolls
   * with the list), else the item's nearest positioned ancestor. Only a
   * scroll container is ever given position:relative. */
  private static hostOf(el: HTMLElement, scope: HTMLElement | null | undefined): { host: HTMLElement; scroller: boolean } {
    let n: HTMLElement | null = el.parentElement;
    while (n && n !== scope && n !== document.body) {
      if (n.hasAttribute('data-sel-host')) return { host: n, scroller: true };
      const oy = window.getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return { host: n, scroller: true };
      n = n.parentElement;
    }
    const op = el.offsetParent;
    return { host: op instanceof HTMLElement ? op : document.body, scroller: false };
  }

  private applyGlow(): void {
    const el =
      this.count > 0 && !this.suspended && this.touched
        ? (this.items[this.settledIndex] ?? null)
        : null;
    if (this.selEl !== el) {
      this.selEl?.classList.remove('fx-sel-on');
      el?.classList.add('fx-sel-on');
      this.selEl = el;
    }
    this.placeIndicator(el);
  }

  private placeIndicator(el: HTMLElement | null): void {
    if (!el || el.getAttribute('data-glow') === 'none') {
      this.hideIndicator();
      return;
    }
    const kind = el.getAttribute('data-sel') ?? 'box';
    const t =
      kind === 'tile'
        ? ((el.querySelector('[data-glow-target]') as HTMLElement | null) ?? el)
        : el.hasAttribute('data-sel-parent') && el.parentElement
          ? el.parentElement
          : el;
    const { host, scroller } = FocusManager.hostOf(el, this.activeScope());
    if (scroller && window.getComputedStyle(host).position === 'static') host.style.position = 'relative';
    // offset inside the host's scrolled content, transform-independent
    let x = 0;
    let y = 0;
    let n: HTMLElement | null = t;
    while (n && n !== host) {
      x += n.offsetLeft;
      y += n.offsetTop;
      const p = n.offsetParent as HTMLElement | null;
      if (p && p !== host) {
        x += p.clientLeft;
        y += p.clientTop;
      }
      n = p;
    }
    if (n !== host) {
      const hr = host.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      x = tr.left - hr.left + host.scrollLeft;
      y = tr.top - hr.top + host.scrollTop;
    }
    // 1.4.4: 'link' (See all) hugs its own padded box: no extra pad, the
    // element's own radius. Offsets are layout boxes, so a focusable must
    // never be positioned with a transform (see SeeAll).
    const pad = kind === 'tile' ? 5 : kind === 'dot' ? 2 : 0;
    const w = t.offsetWidth + pad * 2;
    const h = t.offsetHeight + pad * 2;
    x -= pad;
    y -= pad;

    let ind = this.ind;
    const fresh = !ind || ind.parentElement !== host || ind.style.opacity === '0';
    if (!ind) {
      ind = document.createElement('div');
      ind.className = 'fx-sel';
      ind.setAttribute('aria-hidden', 'true');
      ind.appendChild(document.createElement('span'));
      this.ind = ind;
    }
    if (ind.parentElement !== host) host.appendChild(ind);
    const radius =
      kind === 'dot'
        ? '9999px'
        : kind === 'tile'
          ? window.getComputedStyle(t).borderRadius === '9999px' || t.classList.contains('rounded-full')
            ? '9999px'
            : '22px'
          : window.getComputedStyle(t).borderRadius || '16px';
    ind.dataset.kind = kind;
    if (fresh) ind.style.transition = 'opacity 160ms ease-out';
    else ind.style.transition = '';
    ind.style.width = `${w}px`;
    ind.style.height = `${h}px`;
    ind.style.borderRadius = radius === '0px' ? '16px' : radius;
    ind.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    ind.style.opacity = '1';
  }

  private hideIndicator(): void {
    if (this.ind) this.ind.style.opacity = '0';
  }

  private clearGlow(): void {
    this.selEl?.classList.remove('fx-sel-on');
    this.selEl = null;
    this.hideIndicator();
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

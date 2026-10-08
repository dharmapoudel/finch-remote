// Now Playing, in finch-remote 1.2.1's split layout: full-bleed art on the
// left, the info column on the right (clock, "<client>" pill, title,
// artist, "Playing on <device>", accent seek bar, transport row). The same
// sheet folds into the mini player and the 4px sliver.
//
// 1.4.1 morph (rewritten): every element keeps one fixed geometry for the
// whole fold, so no text ever reflows and nothing is re-laid out mid-motion.
// The sheet slides with a transform; inside it the art is a shared element
// that scales from the 440x480 panel onto the 64px mini thumbnail, and the
// title block is a shared crossfade pair (the full title flies and shrinks
// to the mini title's spot while the mini title grows out of the full one).
// Everything else only fades. Only transform and opacity are ever written,
// with Finch 1.3.1's 380 ms ease-out curve when animated; during a drag the
// same values follow the finger. All state and commands come from Finch's
// own remote logic (usePb()).
import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX, type TouchEvent as RTouchEvent } from 'react';
import { useAccent, type Accent } from '../accent';
import { artKey, cachedArt, HERO_PX, TILE_PX, useArtUrl } from '../art';
import { useBlurred } from '../blur';
import type { Api } from '../demo';
import { artistLine, type Lyrics } from '../jellyfin';
import { Ghost, Icon, ProgressBar } from './components';
import { usePb } from './playback';

const W = 800;
const H = 480;
const ART_W = 440; // 55% of the screen, as in 1.4.0
const MINI_H = 84;
const SLIVER_H = 4;
const MINI_Y = H - MINI_H;
const SLIVER_Y = H - SLIVER_H;
// 1.4.2: invisible touch zone over the bottom of the screen while folded to
// the sliver (the 4px sliver itself is unchanged).
const SLIVER_HIT = 44;
const THUMB = 64;
const THUMB_X = 10;
const THUMB_Y = (MINI_H - THUMB) / 2;
const MINI_TEXT_X = THUMB_X + THUMB + 14;
// Finch 1.3.1's motion: 380 ms, ease-out (its view / sheet transitions).
const DUR = 380;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const FULL_TITLE_PX = 28;
const MINI_TITLE_PX = 17;
// Seek bar offset inside its 64px slot (see InfoPanel); tuned so the bar +
// times sit midway between the shuffle row and the transport glyphs.
const SEEK_PAD = 33;
// Fallback accent, only when the track has no art (Finch's gold).
const GOLD = '#d2a02e';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Sharp hero art over a pre-blurred placeholder (no live blur). */
function HeroArt({ lowSrc, highSrc, alt }: { lowSrc: string | null; highSrc: string | null; alt: string }): JSX.Element {
  const blurred = useBlurred(lowSrc);
  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-900">
      {blurred ? <img src={blurred} alt="" aria-hidden="true" draggable={false} className="absolute inset-0 h-full w-full object-cover" /> : null}
      {highSrc ? (
        <img key={highSrc} src={highSrc} alt={alt} decoding="async" draggable={false} className="animate-hero-in absolute inset-0 h-full w-full object-cover" />
      ) : lowSrc ? (
        <img src={lowSrc} alt={alt} draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
    </div>
  );
}

// ---- lyrics (Finch 1.3.1 loader, finch-remote panel look) ----

const lyricsCache = new Map<string, Lyrics | null>();

function useLyrics(api: Api | null, itemId: string | undefined) {
  const [state, setState] = useState<{ id?: string; status: 'loading' | 'none' | 'ok' | 'error'; data: Lyrics | null }>({
    status: 'loading',
    data: null,
  });
  useEffect(() => {
    if (!api || !itemId) return;
    if (lyricsCache.has(itemId)) {
      const data = lyricsCache.get(itemId) ?? null;
      setState({ id: itemId, status: data ? 'ok' : 'none', data });
      return;
    }
    let live = true;
    setState({ id: itemId, status: 'loading', data: null });
    // 1.4.4: lyrics wait for an idle link (after the poll and the cover)
    api.withPriority('low').lyrics(itemId).then(
      data => {
        lyricsCache.set(itemId, data);
        if (live) setState({ id: itemId, status: data ? 'ok' : 'none', data });
      },
      () => live && setState({ id: itemId, status: 'error', data: null }),
    );
    return () => {
      live = false;
    };
  }, [api, itemId]);
  return state.id === itemId ? state : { status: 'loading' as const, data: null };
}

function activeLine(lyrics: Lyrics, t: number): number {
  let active = -1;
  for (let i = 0; i < lyrics.lines.length; i++) if ((lyrics.lines[i].startMs ?? Infinity) <= t) active = i;
  return active;
}

function SyncedLyrics({ lyrics, live }: { lyrics: Lyrics; live: boolean }) {
  const pb = usePb();
  const boxRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef(new Map<number, HTMLButtonElement>());
  // lead the vocal slightly: the poll-based clock trails the player a little
  const [active, setActive] = useState(() => activeLine(lyrics, pb.positionNow() + 150));
  const playing = !pb.paused;
  const posNow = pb.positionNow;

  // 1.4.1: check the line 4x a second but re-render only when it changes.
  useEffect(() => {
    const check = () => setActive(activeLine(lyrics, posNow() + 150));
    check();
    if (!playing) return;
    const id = window.setInterval(check, 250);
    return () => window.clearInterval(id);
  }, [playing, lyrics, posNow, pb.durationMs]);

  // 1.4.2 (sliver-at-top fix): scroll ONLY the lyrics box. 1.4.1 used
  // scrollIntoView({ block: 'center' }), which also scrolls every scrollable
  // ancestor. With the sheet folded to the sliver (translated to y=476) the
  // active line sat below the screen, so the browser scrolled the App root
  // (overflow:hidden is still scrollable by script) up by ~476 px: the whole
  // UI moved off screen and the sliver showed at the top. While folded the
  // panel is not followed at all; it jumps to the line when unfolded.
  const wasLive = useRef(live);
  useEffect(() => {
    const box = boxRef.current;
    const el = lineRefs.current.get(Math.max(0, active));
    const jump = live && !wasLive.current;
    wasLive.current = live;
    if (!box || !el || !live) return;
    const top = Math.max(0, el.offsetTop - (box.clientHeight - el.offsetHeight) / 2);
    box.scrollTo({ top, behavior: jump ? 'auto' : 'smooth' });
  }, [active, live]);

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-y-auto px-6 py-8 pb-[60%]">
      {lyrics.lines.map((l, i) => {
        const isActive = i === active;
        if (!l.text) return <div key={i} className="h-4" />;
        return (
          <button
            key={i}
            type="button"
            ref={el => {
              if (el) lineRefs.current.set(i, el);
              else lineRefs.current.delete(i);
            }}
            onClick={() => l.startMs != null && pb.act.seekTo(l.startMs)}
            className={`block w-full rounded-2xl px-4 py-2.5 text-center transition-colors active:bg-white/10 ${
              isActive ? 'text-3xl font-bold text-goldlight' : i < active ? 'text-2xl font-medium text-white/30' : 'text-2xl font-medium text-white/50'
            }`}
          >
            {l.text}
          </button>
        );
      })}
    </div>
  );
}

function LyricsPanel({ lyr, live }: { lyr: { status: 'loading' | 'none' | 'ok' | 'error'; data: Lyrics | null }; live: boolean }) {
  if (lyr.status === 'loading') {
    return <div className="flex h-full w-full items-center justify-center text-2xl text-white/50">Loading lyrics…</div>;
  }
  if (lyr.status !== 'ok' || !lyr.data) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Icon name="lyrics" size={56} className="text-white/20" />
        <div className="text-2xl font-semibold text-white/70">{lyr.status === 'error' ? "Couldn't load lyrics" : 'No lyrics for this track'}</div>
        <div className="text-lg leading-snug text-white/40">Add .lrc files next to your music in Jellyfin</div>
      </div>
    );
  }
  if (!lyr.data.synced) {
    return (
      <div className="h-full w-full overflow-y-auto px-8 py-6">
        <div className="text-center text-2xl leading-relaxed whitespace-pre-line text-white/85">{lyr.data.lines.map(l => l.text).join('\n')}</div>
      </div>
    );
  }
  return <SyncedLyrics lyrics={lyr.data} live={live} />;
}

// Keep the Glass Overlay's ambient screensaver off while Now Playing is up.
const AMBIENT_INHIBIT_EVENT = 'bridgething:ambient-inhibit';
const AMBIENT_INHIBIT_FLAG = '__bridgethingAmbientInhibit';
function setAmbientInhibit(inhibit: boolean): void {
  try {
    (window as unknown as Record<string, unknown>)[AMBIENT_INHIBIT_FLAG] = inhibit;
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(AMBIENT_INHIBIT_EVENT, { detail: { inhibit } }));
}

/** hh:mm:ss, once a second (1.4.0 re-rendered it 4x a second for the colon blink). */
const Clock = memo(function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id = 0;
    const tick = () => {
      setNow(Date.now());
      id = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    id = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => window.clearTimeout(id);
  }, []);
  const parts = new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).split(':');
  const dim = Math.floor(now / 1000) % 2 === 1;
  const colon = <span style={{ opacity: dim ? 0.35 : 1 }}>:</span>;
  return (
    <span className="shrink-0 font-mono text-white/35 tabular-nums" style={{ fontSize: 15 }}>
      {parts[0]}
      {colon}
      {parts[1]}
      {colon}
      {parts[2]}
    </span>
  );
});

/**
 * 1.4.3 icon-only Instant mix pill: tap starts a mix of the playing track
 * (which toasts "Instant mix from <name>"); a long press (500 ms) only shows
 * the "Instant mix" hint. The pill draws 44x32 inside a 44x44 hit area that
 * overhangs the 40 px row by 2 px each side (no layout change).
 */
function MixPill({ disabled, onMix, onHint }: { disabled: boolean; onMix: () => void; onHint: () => void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return (
    <button
      type="button"
      aria-label="Instant mix"
      title="Instant mix"
      disabled={disabled}
      onPointerDown={() => {
        held.current = false;
        clear();
        timer.current = window.setTimeout(() => {
          held.current = true;
          onHint();
        }, 500);
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={e => e.preventDefault()}
      onClick={() => {
        clear();
        if (held.current) {
          held.current = false;
          return;
        }
        onMix();
      }}
      className="group -my-0.5 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center text-white/45 disabled:opacity-30"
    >
      {/* 1.4.4: a plain icon like shuffle / repeat (same 20 px glyph, same
          off colour, no chip), since it is an action, not a toggle. The
          44 x 44 button is the hit area; a press only flashes the glyph. */}
      <span className="grid place-items-center transition-[transform,opacity] duration-150 ease-out group-active:scale-85 group-active:opacity-60">
        <Icon name="mix" size={20} />
      </span>
    </button>
  );
}

function SmallToggle({
  label,
  on,
  onClick,
  children,
  accent,
  disabled,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={on && accent ? { color: accent } : undefined}
      className={`relative flex h-10 min-w-9 items-center justify-center gap-1.5 rounded-full px-1.5 text-sm transition-colors active:bg-white/10 disabled:opacity-30 ${
        on ? (accent ? '' : 'text-leaf') : 'text-white/45'
      }`}
    >
      {children}
    </button>
  );
}

function InfoPanel({
  accent,
  bgArtUrl,
  hasLyrics,
  titleRef,
}: {
  accent: Accent | null;
  bgArtUrl: string | null;
  hasLyrics: boolean;
  titleRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pb = usePb();
  const t = pb.item;
  const blurred = useBlurred(bgArtUrl);
  if (!t) return null;
  const tint = accent?.fill ?? GOLD;
  const fav = pb.isFav;
  return (
    <div className="relative h-full w-full">
      {/* static backdrop: pre-blurred art + accent wash (no backdrop-filter) */}
      <div className="np-full absolute inset-0 overflow-hidden" aria-hidden="true">
        {blurred ? (
          <img src={blurred} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ opacity: 0.4 }} />
        ) : null}
        <div
          className="absolute inset-0"
          style={{
            background: accent
              ? `linear-gradient(155deg, color-mix(in oklab, ${accent.fill} 14%, rgba(11,13,16,0.9)), rgba(11,13,16,0.92) 78%)`
              : 'rgba(11,13,16,0.92)',
          }}
        />
      </div>
      <div className="absolute inset-0 flex flex-col px-5 pt-5 pb-4">
        <div className="np-full flex h-8 shrink-0 items-center justify-between">
          <Clock />
          <button
            type="button"
            aria-label="Play on another device"
            onClick={pb.act.openPlayOn}
            className="relative flex max-w-[200px] items-center gap-1.5 rounded-full border border-white/15 py-1.5 pr-3 pl-2.5 text-sm text-white/65 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] active:bg-white/10"
          >
            {/* 1.4.3: cast icon + client name, no "via"; the invisible
                ::before stretches the touch target to 44 px tall */}
            {pb.pollError ? <span className="h-2 w-2 shrink-0 rounded-full bg-red-400" /> : <Icon name="cast" size={16} className="shrink-0" />}
            <span className="truncate">{pb.target?.Client ?? 'Jellyfin'}</span>
          </button>
        </div>

        {/* Fixed height so nothing below moves when titles wrap. */}
        <div className="relative flex h-[178px] min-w-0 shrink-0 flex-col justify-center pt-[16px]">
          {pb.loadingTrack ? (
            <div className="np-full mb-1 flex items-center gap-2 text-sm font-semibold tracking-[0.18em] text-leaf uppercase">
              <span className="eq">
                <i />
                <i />
                <i />
              </span>
              Loading next track
            </div>
          ) : null}
          <div ref={titleRef} className="np-title min-w-0 shrink-0 origin-top-left">
            <div
              className={`line-clamp-3 font-display leading-[1.2] font-semibold tracking-display text-[#efefef] ${pb.loadingTrack ? 'opacity-50' : ''}`}
              style={{ fontSize: FULL_TITLE_PX }}
            >
              {t.Name}
            </div>
            <div className="np-full mt-1.5 truncate text-[1.25rem] text-white/55">{artistLine(t)}</div>
            <div className="np-full mt-1 truncate text-[1.05rem] text-leaf">Playing on {pb.target?.DeviceName ?? 'your player'}</div>
          </div>
        </div>

        {/* 1.4.2 fixed geometry (column y, px): header 20-52, title 52-230,
            gap, shuffle / repeat / Instant mix row 280-320 (just above where
            1.4.1's seek bar sat), seek bar centred between that row and the
            transport row (384-444). Nothing here depends on content size, so
            the full <-> mini <-> sliver morph stays transform/opacity only. */}
        <div className="h-[50px] shrink-0" aria-hidden="true" />
        <div className="np-full np-extras flex h-10 shrink-0 items-center gap-1">
          <SmallToggle label={pb.shuffle ? 'Shuffle on' : 'Shuffle off'} on={pb.shuffle} onClick={pb.act.toggleShuffle} accent={tint}>
            <Icon name="shuffle" size={20} />
          </SmallToggle>
          <SmallToggle
            label={pb.repeat === 'RepeatNone' ? 'Repeat off' : pb.repeat === 'RepeatAll' ? 'Repeat all' : 'Repeat one'}
            on={pb.repeat !== 'RepeatNone'}
            onClick={pb.act.cycleRepeat}
            accent={tint}
          >
            <Icon name={pb.repeat === 'RepeatOne' ? 'repeatOne' : 'repeat'} size={20} />
          </SmallToggle>
          <MixPill
            disabled={!pb.nowId}
            onMix={() => {
              const now = pb.nowId && pb.item?.Id === pb.nowId ? pb.item : null;
              if (now) void pb.act.instantMix(now);
            }}
            onHint={() => pb.act.toast('Instant mix')}
          />
        </div>

        <div className="np-full np-seekrow min-h-0 flex-1" style={{ paddingTop: SEEK_PAD }}>
          <ProgressBar fill={tint} />
        </div>

        <div className="np-full flex h-[60px] w-full shrink-0 items-center justify-between px-1">
          <Ghost
            label={hasLyrics ? (pb.showLyrics ? 'Hide lyrics' : 'Show lyrics') : 'No lyrics for this track'}
            disabled={!hasLyrics}
            onClick={pb.act.toggleLyrics}
            tint={pb.showLyrics && hasLyrics ? '#34d399' : undefined}
            className={pb.showLyrics && hasLyrics ? '' : 'opacity-40'}
          >
            <Icon name="lyrics" size={26} />
          </Ghost>
          <Ghost label="Previous" onClick={pb.act.prev} tint={tint}>
            <Icon name="prev" size={32} />
          </Ghost>
          <Ghost label={pb.paused ? 'Play' : 'Pause'} onClick={pb.act.toggle} tint={tint} focusDefault>
            {pb.loadingTrack ? (
              <span className="block h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-white/85" />
            ) : (
              <span key={pb.paused ? 'play' : 'pause'} className="grid animate-pop place-items-center">
                <Icon name={pb.paused ? 'play' : 'pause'} size={40} />
              </span>
            )}
          </Ghost>
          <Ghost label="Next" onClick={pb.act.next} tint={tint}>
            <Icon name="next" size={32} />
          </Ghost>
          <Ghost
            label={fav ? 'Remove from favorites' : 'Add to favorites'}
            onClick={pb.act.toggleFav}
            tint={fav ? '#34d399' : undefined}
            className={fav ? '' : 'opacity-40'}
          >
            {/* 1.4.3: 22 px, not 26: the heart is a wide closed shape, so at
                the lyrics glyph's box it read bigger and heavier. 22 px keeps
                the same ~2 px stroke (strokeFor) at the lyrics glyph's optical size. */}
            <Icon name={fav ? 'heartFill' : 'heart'} size={22} />
          </Ghost>
        </div>
        {pb.pollError ? <div className="np-full absolute inset-x-5 bottom-1 truncate text-center text-sm text-red-300">{pb.pollError}</div> : null}
      </div>
    </div>
  );
}

/** The mini player's own content (fixed 84px geometry at the top of the sheet). */
function MiniBar({ thumbUrl, accent, titleRef }: { thumbUrl: string | null; accent: Accent | null; titleRef: React.RefObject<HTMLDivElement | null> }) {
  const pb = usePb();
  const t = pb.item!;
  const tint = accent?.fill ?? GOLD;
  return (
    <>
      <div
        ref={titleRef}
        className="np-mini-title pointer-events-none absolute min-w-0 origin-top-left"
        style={{ left: MINI_TEXT_X, top: 18, width: W - MINI_TEXT_X - 200 }}
      >
        <div className="truncate font-display leading-[1.2] font-semibold tracking-display text-[#efefef]" style={{ fontSize: MINI_TITLE_PX }}>
          {t.Name}
        </div>
        <div className="np-mini mt-0.5 truncate text-[15px] leading-tight text-white/55">{artistLine(t)}</div>
      </div>
      <div className="np-mini absolute top-0 right-4 flex h-[84px] items-center gap-6">
        <Ghost label="Previous" onClick={pb.act.prev} tint={tint}>
          <Icon name="prev" size={26} />
        </Ghost>
        <Ghost label={pb.paused ? 'Play' : 'Pause'} onClick={pb.act.toggle} tint={tint}>
          {pb.loadingTrack ? (
            <span className="block h-8 w-8 animate-spin rounded-full border-[3px] border-white/15 border-t-white/85" />
          ) : (
            <Icon name={pb.paused ? 'play' : 'pause'} size={32} />
          )}
        </Ghost>
        <Ghost label="Next" onClick={pb.act.next} tint={tint}>
          <Icon name="next" size={26} />
        </Ghost>
      </div>
      <div className="np-thumb pointer-events-none absolute overflow-hidden rounded-xl bg-zinc-800" style={{ left: THUMB_X, top: THUMB_Y, width: THUMB, height: THUMB }}>
        {thumbUrl ? <img src={thumbUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : null}
      </div>
    </>
  );
}

type Els = {
  art: HTMLElement | null;
  full: HTMLElement[];
  mini: HTMLElement[];
  thumb: HTMLElement | null;
  fullTitle: HTMLElement | null;
  miniTitle: HTMLElement | null;
  seek: HTMLElement | null;
};

/** Undo any script scroll on the sheet's ancestors and the document. */
function unscrollAncestors(el: HTMLElement): void {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.scrollTop !== 0) n.scrollTop = 0;
    if (n.scrollLeft !== 0) n.scrollLeft = 0;
  }
  const doc = document.scrollingElement;
  if (doc && (doc.scrollTop !== 0 || doc.scrollLeft !== 0)) doc.scrollTo(0, 0);
}

function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== root) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

function NowPlaying({
  miniState,
  onCollapse,
  onClose,
}: {
  miniState: 'hidden' | 'mini' | 'sliver';
  onCollapse: (target: 'mini' | 'sliver' | 'hidden') => void;
  onClose: () => void;
}) {
  const pb = usePb();
  const t = pb.item;
  const trackId = t?.Id;
  const lyr = useLyrics(pb.api, trackId);
  const hasLyrics = lyr.status === 'ok';
  const showLyrics = pb.showLyrics && hasLyrics;

  const sheetRef = useRef<HTMLDivElement>(null);
  const fullTitleRef = useRef<HTMLDivElement>(null);
  const miniTitleRef = useRef<HTMLDivElement>(null);
  const yRef = useRef<number | null>(null); // current sheet offset (px), the single source of truth
  const titleDelta = useRef<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<{ startY: number; baseY: number; dy: number; startT: number; target: EventTarget | null } | null>(null);
  const stallTimerRef = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);

  const els = (): Els => {
    const root = sheetRef.current;
    const q = (s: string) => (root ? [...root.querySelectorAll<HTMLElement>(s)] : []);
    return {
      art: root?.querySelector<HTMLElement>('.np-art') ?? null,
      full: q('.np-full'),
      mini: q('.np-mini'),
      thumb: root?.querySelector<HTMLElement>('.np-thumb') ?? null,
      fullTitle: fullTitleRef.current,
      miniTitle: miniTitleRef.current,
      seek: root?.querySelector<HTMLElement>('.np-seek') ?? null,
    };
  };

  /** Where the full title sits relative to the mini title (measured from layout, not transforms). */
  const measureTitles = () => {
    const root = sheetRef.current;
    const f = fullTitleRef.current;
    const m = miniTitleRef.current;
    if (!root || !f || !m) return;
    const a = offsetIn(f, root);
    const b = offsetIn(m, root);
    titleDelta.current = { dx: b.x - a.x, dy: b.y - a.y };
  };

  /**
   * Put every morphing element where it belongs for sheet offset y.
   * dir: null = follow the finger (no transitions); 'down' / 'up' = animate
   * there with 1.3.1's curve, opacity staggered so the full layout clears
   * before the mini bar appears (and the reverse going up).
   */
  const layout = (yIn: number, dir: 'down' | 'up' | null) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    // guard: the sheet only ever lives between full (0) and the sliver
    const y = Number.isFinite(yIn) ? Math.min(SLIVER_Y, Math.max(0, yIn)) : SLIVER_Y;
    yRef.current = y;
    const p = clamp01(y / MINI_Y); // full -> mini
    const q = clamp01((y - MINI_Y) / (SLIVER_Y - MINI_Y)); // mini -> sliver
    const e = els();
    if (!titleDelta.current) measureTitles();
    const td = titleDelta.current ?? { dx: 0, dy: 0 };
    const s = MINI_TITLE_PX / FULL_TITLE_PX;

    const down = dir === 'down';

    sheet.style.transition = dir ? `transform ${DUR}ms ${EASE}` : 'none';
    sheet.style.transform = `translate3d(0, ${y}px, 0)`;

    // full layout: gone in the first third of the fold
    const fullO = clamp01(1 - p * 3);
    for (const el of e.full) {
      el.style.transition = dir ? `opacity ${down ? 140 : 220}ms ease-out ${down ? 0 : 140}ms` : 'none';
      el.style.opacity = String(fullO);
      el.style.pointerEvents = p > 0.5 ? 'none' : '';
      if (p > 0.5) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    }
    // shared art: the 440x480 panel scales onto the thumbnail's spot
    if (e.art) {
      const k = lerp(1, THUMB / ART_W, p);
      const ty = lerp(0, THUMB_Y - ((H * THUMB) / ART_W - THUMB) / 2, p);
      // down: the art hides under the thumbnail at the very end; up: it is
      // shown at once (the thumbnail hides in the same frame)
      e.art.style.transition = dir ? `transform ${DUR}ms ${EASE}${down ? `, opacity 100ms linear 300ms` : ''}` : 'none';
      e.art.style.transform = `translate3d(${lerp(0, THUMB_X, p)}px, ${ty}px, 0) scale(${k})`;
      e.art.style.opacity = p >= 0.98 ? '0' : '1';
    }
    // mini thumbnail takes over at the very end of the fold (crossfade)
    const thumbO = clamp01((p - 0.8) / 0.18) * (1 - q);
    if (e.thumb) {
      // going up the art (already at the thumbnail's spot) takes over at once
      e.thumb.style.transition = dir === 'down' ? `opacity 120ms linear 250ms` : 'none';
      e.thumb.style.opacity = String(thumbO);
    }
    // shared title: full title flies to the mini title's spot and shrinks...
    if (e.fullTitle) {
      e.fullTitle.style.transition = dir
        ? `transform ${DUR}ms ${EASE}, opacity ${down ? 220 : 180}ms linear ${down ? 40 : 40}ms`
        : 'none';
      e.fullTitle.style.transform = `translate3d(${td.dx * p}px, ${td.dy * p}px, 0) scale(${lerp(1, s, p)})`;
      e.fullTitle.style.opacity = String(clamp01(1 - (p - 0.15) / 0.45));
    }
    // ...while the mini title grows out of it
    if (e.miniTitle) {
      const r = 1 - p;
      e.miniTitle.style.transition = dir
        ? `transform ${DUR}ms ${EASE}, opacity ${down ? 200 : 200}ms linear ${down ? 60 : 60}ms`
        : 'none';
      e.miniTitle.style.transform = `translate3d(${-td.dx * r}px, ${-td.dy * r}px, 0) scale(${lerp(1, 1 / s, r)})`;
      e.miniTitle.style.opacity = String(clamp01((p - 0.3) / 0.45) * (1 - q));
    }
    const miniO = clamp01((p - 0.5) / 0.4) * (1 - q);
    for (const el of e.mini) {
      el.style.transition = dir ? `opacity ${down ? 200 : 120}ms ease-out ${down ? 170 : 0}ms` : 'none';
      el.style.opacity = String(miniO);
      const miniLive = p > 0.5 && q < 0.5;
      el.style.pointerEvents = miniLive ? '' : 'none';
      if (miniLive) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', 'true');
    }
    if (e.seek) {
      e.seek.style.transition = dir ? `opacity ${down ? 200 : 120}ms ease-out ${down ? 150 : 0}ms` : 'none';
      e.seek.style.opacity = String(clamp01((p - 0.5) / 0.4));
    }
  };

  const setWillChange = (on: boolean) => {
    const e = els();
    for (const el of [e.art, e.thumb, e.fullTitle, e.miniTitle, ...e.full, ...e.mini]) {
      if (el) el.style.willChange = on ? 'transform, opacity' : '';
    }
  };

  const animateTo = (target: number, then?: () => void) => {
    const from = yRef.current ?? target;
    measureTitles();
    // CSS transitions on transform/opacity are composited by the browser on
    // their own; will-change is only added for finger drags (see below).
    layout(target, target >= from ? 'down' : 'up');
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      if (!dragRef.current) setWillChange(false);
      then?.();
      guardPosition();
    }, DUR + 40);
  };

  /**
   * 1.4.2 guard: the sheet must sit exactly at its offset inside the
   * 800x480 screen. If anything scrolled an ancestor (or the document), put
   * the scroll back to 0; if the sheet still is not where it belongs,
   * re-apply the layout for the current fold state.
   */
  const guardPosition = () => {
    const sheet = sheetRef.current;
    if (!sheet || dragRef.current || settleTimer.current) return;
    unscrollAncestors(sheet);
    const host = sheet.parentElement;
    if (!host) return;
    // never interrupt a running fold (a slow frame can outlast the timer)
    if (sheet.getAnimations?.().some(an => an.playState === 'running')) return;
    // the intended offset is yRef (set by every layout); App's miniState can
    // lag it by a render right after a fold settles
    const want = yRef.current ?? yFor(miniStateRef.current);
    const got = sheet.getBoundingClientRect().top - host.getBoundingClientRect().top;
    if (Math.abs(got - want) > 2) layout(want, null);
  };
  const miniStateRef = useRef(miniState);
  miniStateRef.current = miniState;

  const yFor = (m: 'hidden' | 'mini' | 'sliver') => (m === 'hidden' ? 0 : m === 'mini' ? MINI_Y : SLIVER_Y);

  // First placement: no animation (Finch starts with the sliver showing).
  useLayoutEffect(() => {
    if (yRef.current === null) layout(yFor(miniState), null);
    guardPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any scroll of an ancestor (they are all overflow:hidden/clip, so only a
  // script can do it) is undone at once, and the position re-checked.
  useEffect(() => {
    const onScroll = (e: Event) => {
      const sheet = sheetRef.current;
      const tgt = e.target;
      if (!sheet) return;
      const isAncestor = tgt === document || (tgt instanceof Node && tgt !== sheet && tgt.contains(sheet));
      if (isAncestor) guardPosition();
    };
    window.addEventListener('scroll', onScroll, true);
    const id = window.setInterval(guardPosition, 3000);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow App's miniState (Back, a tile tap, preset hold).
  useEffect(() => {
    const target = yFor(miniState);
    if (yRef.current === null || Math.abs(yRef.current - target) > 1) animateTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniState, !!t]);

  // A new track remounts the titles: re-measure and re-apply the same state.
  // Lyrics turning on (remembered setting, or a new track's lyrics loading)
  // only re-applies the CURRENT fold state; it never opens the sheet.
  useLayoutEffect(() => {
    titleDelta.current = null;
    if (yRef.current !== null) layout(yRef.current, null);
    guardPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, showLyrics, pb.loadingTrack, !!t]);

  useEffect(() => {
    if (miniState !== 'hidden') return;
    setAmbientInhibit(true);
    return () => setAmbientInhibit(false);
  }, [miniState]);

  const onTouchStart = (e: RTouchEvent): void => {
    const baseY = yRef.current ?? 0;
    // lyrics scroll by touch on the full sheet
    if (baseY < MINI_Y * 0.5 && showLyrics && (e.target as HTMLElement).closest?.('.np-lyrics')) return;
    measureTitles();
    setWillChange(true);
    dragRef.current = { startY: e.touches[0].clientY, baseY, dy: 0, startT: Date.now(), target: e.target };
  };
  const onTouchMove = (e: RTouchEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.touches[0].clientY - d.startY;
    d.dy = dy;
    layout(Math.min(SLIVER_Y, Math.max(0, d.baseY + dy)), null);
    if (stallTimerRef.current) window.clearTimeout(stallTimerRef.current);
    const lastDy = dy;
    stallTimerRef.current = window.setTimeout(() => {
      if (dragRef.current && dragRef.current.dy === lastDy) onTouchEnd();
    }, 500);
  };
  const onTouchEnd = (): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (stallTimerRef.current) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (!d) return;
    const { baseY, dy } = d;
    const dt = Date.now() - d.startT;
    const y = Math.min(SLIVER_Y, Math.max(0, baseY + dy));
    const isFlick = dt < 300 && Math.abs(dy) > 24;
    const flickDir = isFlick ? Math.sign(dy) : 0;
    let target: 'hidden' | 'mini' | 'sliver';
    const fromFull = baseY < MINI_Y * 0.5;
    const fromMini = !fromFull && baseY < (MINI_Y + SLIVER_Y) / 2;
    if (fromFull) {
      if (flickDir > 0 || y >= (MINI_Y + SLIVER_Y) / 2) target = 'sliver';
      else if (y >= MINI_Y * 0.4) target = 'mini';
      else target = 'hidden';
    } else if (fromMini) {
      const tgt = d.target as HTMLElement | null;
      const onInteractive = !!tgt?.closest?.('button, a, input');
      const isTap = Math.abs(dy) < 10 && dt < 300 && !onInteractive;
      if (isTap) target = 'hidden';
      else if (flickDir > 0 || y >= (MINI_Y + SLIVER_Y) / 2) target = 'sliver';
      else if (flickDir < 0 || y <= MINI_Y * 0.6) target = 'hidden';
      else target = 'mini';
    } else {
      const isTap = Math.abs(dy) < 10 && dt < 300;
      if (isTap) target = 'hidden';
      else if (flickDir < 0 || y <= (MINI_Y + SLIVER_Y) / 2) target = 'mini';
      else target = 'sliver';
    }
    animateTo(yFor(target), () => onCollapse(target));
  };

  // ---- 1.4.2 sliver hit zone: pointer events (touch, pen, mouse) with
  // touch-action:none + pointer capture, so nothing underneath (lists,
  // backdrop) can take the gesture once it starts. Tap -> mini player; a
  // flick (>= 10px up, quicker than 250 ms or >= 0.15 px/ms) -> mini; a
  // slow drag of >= 20px up -> mini; a drag follows the finger
  // and settles on mini or full by where it is let go.
  const zoneRef = useRef<{ id: number; startY: number; t: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null);
  const onZoneDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (zoneRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    measureTitles();
    setWillChange(true);
    const now = performance.now();
    zoneRef.current = { id: e.pointerId, startY: e.clientY, t: now, lastY: e.clientY, lastT: now, v: 0, moved: false };
  };
  const onZoneMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const z = zoneRef.current;
    if (!z || e.pointerId !== z.id) return;
    e.preventDefault();
    const now = performance.now();
    const dt = Math.max(1, now - z.lastT);
    // smoothed velocity (px/ms, negative = up)
    z.v = 0.6 * ((e.clientY - z.lastY) / dt) + 0.4 * z.v;
    z.lastY = e.clientY;
    z.lastT = now;
    const dy = e.clientY - z.startY;
    if (Math.abs(dy) > 4) z.moved = true;
    if (z.moved) layout(Math.min(SLIVER_Y, Math.max(0, SLIVER_Y + dy)), null);
  };
  const onZoneEnd = (e: React.PointerEvent<HTMLDivElement>, cancelled = false): void => {
    const z = zoneRef.current;
    if (!z || e.pointerId !== z.id) return;
    zoneRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const dy = e.clientY - z.startY;
    const dt = performance.now() - z.t;
    const y = Math.min(SLIVER_Y, Math.max(0, SLIVER_Y + dy));
    const v = z.v; // px/ms, negative = up
    let target: 'hidden' | 'mini' | 'sliver' = 'sliver';
    if (cancelled) target = z.moved && dy < -40 ? 'mini' : 'sliver';
    else if (!z.moved && dt < 500) target = 'mini'; // tap
    else if (y <= MINI_Y * 0.5) target = 'hidden'; // dragged most of the way up
    else if (dy <= -10 && (dt < 250 || v <= -0.15 || dy / Math.max(1, dt) <= -0.15)) target = 'mini'; // short / quick flick
    else if (dy <= -20) target = 'mini'; // slow drag past a short threshold
    animateTo(yFor(target), () => onCollapse(target));
  };

  // Art: the 160px tile art paints first (blurred placeholder), then the
  // hero-size art fades in over it.
  const bgArt = useArtUrl(pb.api, t, TILE_PX);
  const heroArt = useArtUrl(pb.api, t, HERO_PX, !!bgArt || !t);
  // 1.4.2: one sample per cover (art key), from the small tile art; the
  // previous accent holds while the next cover loads.
  const artId = t ? artKey(t, TILE_PX) : null;
  // useArtUrl keeps returning the previous track's URL until the new one
  // loads; only sample a URL that really is this track's art.
  const accentUrl = bgArt && t && cachedArt(t, TILE_PX) === bgArt ? bgArt : null;
  const accent = useAccent(accentUrl, artId, !!artId);
  const lyricsBg = useBlurred(showLyrics ? bgArt : null);

  if (!t) {
    // A folded sheet with no track has nothing to show (never a full-screen
    // empty state stuck behind a "sliver" fold state).
    if (miniState !== 'hidden') return null;
    const noTarget = !pb.target;
    return (
      <div ref={sheetRef} className="pointer-events-auto relative h-full overflow-hidden bg-zinc-950">
        <div className="flex h-full flex-col items-center justify-center gap-5 px-10 text-center">
          {!pb.sessionsLoaded ? (
            <>
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/15 border-t-gold" />
              <div className="text-2xl font-semibold text-white/70">Finding your players…</div>
            </>
          ) : (
            <>
              <Icon name={noTarget ? 'cast' : 'note'} size={84} className="text-white/20" />
              <div className="text-3xl font-semibold text-white/80">
                {noTarget ? (pb.pollError ? "Can't reach Jellyfin" : 'No Jellyfin players') : 'Nothing playing'}
              </div>
              <div className="max-w-[560px] text-lg leading-snug text-white/45">
                {noTarget
                  ? pb.pollError
                    ? `${pb.pollError}. Make sure your phone is connected and on a network that can reach the server.`
                    : 'Open Jellyfin or Finamp on your phone, TV or computer and sign in with the same account. It will show up here.'
                  : `Pick something from your library to play on ${pb.target!.DeviceName}.`}
              </div>
              <div className="mt-1 flex gap-3">
                <button
                  type="button"
                  onClick={pb.act.openPlayOn}
                  className="flex h-16 items-center gap-2 rounded-full border border-white/20 px-7 text-xl font-bold text-white/80 active:bg-white/10"
                >
                  <Icon name="cast" size={22} />
                  Play on…
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="h-16 rounded-full bg-leaf px-7 text-xl font-bold text-black active:brightness-90"
                >
                  Browse your library
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
    {miniState === 'sliver' ? (
      <div
        className="np-sliver-hit pointer-events-auto absolute inset-x-0 bottom-0 z-[45]"
        style={{ height: SLIVER_HIT, touchAction: 'none' }}
        aria-label="Open the mini player"
        role="button"
        onPointerDown={onZoneDown}
        onPointerMove={onZoneMove}
        onPointerUp={e => onZoneEnd(e)}
        onPointerCancel={e => onZoneEnd(e, true)}
        onLostPointerCapture={e => zoneRef.current && onZoneEnd(e, true)}
        onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
      />
    ) : null}
    <div
      ref={sheetRef}
      className="pointer-events-auto absolute top-0 left-0 overflow-hidden bg-[#0b0d10]"
      style={{ width: W, height: H, willChange: 'transform' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onClick={e => {
        // Tap on the mini bar / sliver (not a button) opens fullscreen.
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if ((yRef.current ?? 0) >= MINI_Y * 0.5) animateTo(0, () => onCollapse('hidden'));
      }}
    >
      {/* shared art: one element, scaled between the panel and the thumbnail */}
      <div className="np-art absolute top-0 left-0 origin-top-left overflow-hidden" style={{ width: ART_W, height: H, willChange: 'transform' }}>
        <div key={t.Id} className="h-full w-full">
          {heroArt || bgArt ? (
            <HeroArt lowSrc={bgArt} highSrc={heroArt} alt={t.Album || t.Name} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-zinc-900">
              <Icon name="note" size={96} className="text-white/15" />
            </div>
          )}
        </div>
      </div>

      {/* art overlays belong to the full layout: they fade, never scale */}
      {pb.loadingTrack ? (
        <div className="np-full absolute top-0 left-0 flex items-center justify-center bg-black/60" style={{ width: ART_W, height: H }}>
          <span className="h-14 w-14 animate-spin rounded-full border-[3px] border-white/15 border-t-goldlight" />
        </div>
      ) : showLyrics ? (
        <div className="np-full np-lyrics absolute top-0 left-0 overflow-hidden bg-[#14161c]" style={{ width: ART_W, height: H }}>
          {lyricsBg ? (
            <img src={lyricsBg} alt="" aria-hidden="true" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ opacity: 0.4 }} />
          ) : null}
          <div className="relative h-full w-full">
            <LyricsPanel lyr={lyr} live={miniState === 'hidden'} />
          </div>
        </div>
      ) : null}

      {/* right column (full layout); above the art so the flying title is never clipped */}
      <div className="absolute top-0 h-full" style={{ left: ART_W, width: W - ART_W }}>
        <InfoPanel accent={accent} bgArtUrl={bgArt} hasLyrics={hasLyrics} titleRef={fullTitleRef} />
      </div>

      <MiniBar thumbUrl={bgArt} accent={accent} titleRef={miniTitleRef} />

      <div className="np-seek pointer-events-none absolute inset-x-0 top-0 flex h-1 items-center" style={{ opacity: 0 }}>
        <ProgressBar dot={false} showTimes={false} fill={accent?.fill ?? GOLD} interactive={false} />
      </div>
    </div>
    </>
  );
}

export default memo(NowPlaying);

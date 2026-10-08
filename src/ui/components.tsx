// Shared UI, lifted from finch-remote 1.2.1's components.tsx (icons, tiles,
// rails, rows, seek bar, menus, skeletons, ambient backdrop) and adapted to
// Finch's own data: artwork comes from Finch's art loader (src/art.ts) and
// playback state from Finch's remote-control state (usePb() / useCore() / useNow()).
// Every interactive target is at least 48px; the page is pinned at 800x480.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TILE_PX, useArtUrl } from '../art';
import { useBlurred } from '../blur';
import type { Item } from '../jellyfin';
import { FocusScope } from '../fx/focus';
import { GlassPanel } from '../fx/glass';
import { useCore, useNow, usePb } from './playback';

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---- icons (inline svg, currentColor) ----
// 1.4.1 icon set: one family everywhere. Line glyphs are Finch 1.3.1's
// icons.tsx style (24px grid, round caps/joins, ~2px on-screen stroke at any
// size); transport, filled heart and the overflow dots are solid, as in 1.3.1.
// Glyphs 1.3.1 already had are copied from it verbatim (play, pause, next,
// shuffle, repeat, heart, disc, artist, now-playing note, mix, back,
// check, queue-add, lyrics); 1.4.2 dropped the volume glyphs (speaker, phone); the rest are drawn to match.

type Glyph = { solid?: boolean; d: ReactNode };
const G: Record<string, Glyph> = {
  play: { solid: true, d: <path transform="translate(-1 0)" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /> },
  pause: {
    solid: true,
    d: (
      <>
        <rect x="5.5" y="4" width="4.5" height="16" rx="1.2" />
        <rect x="14" y="4" width="4.5" height="16" rx="1.2" />
      </>
    ),
  },
  next: {
    solid: true,
    d: <path d="M4 5.2v13.6a1 1 0 0 0 1.55.83L15.5 13v5.5a1 1 0 0 0 1 1h1.5a1 1 0 0 0 1-1v-13a1 1 0 0 0-1-1h-1.5a1 1 0 0 0-1 1V11L5.55 4.37A1 1 0 0 0 4 5.2z" />,
  },
  prev: {
    solid: true,
    d: <path transform="matrix(-1 0 0 1 24 0)" d="M4 5.2v13.6a1 1 0 0 0 1.55.83L15.5 13v5.5a1 1 0 0 0 1 1h1.5a1 1 0 0 0 1-1v-13a1 1 0 0 0-1-1h-1.5a1 1 0 0 0-1 1V11L5.55 4.37A1 1 0 0 0 4 5.2z" />,
  },
  heart: { d: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /> },
  heartFill: {
    d: <path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />,
  },
  shuffle: {
    d: (
      <>
        <path d="M16 3h5v5" />
        <path d="M4 20 21 3" />
        <path d="M21 16v5h-5" />
        <path d="M15 15l6 6" />
        <path d="M4 4l5 5" />
      </>
    ),
  },
  repeat: {
    d: (
      <>
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </>
    ),
  },
  repeatOne: {
    d: (
      <>
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        <path d="M11 10.5l1.5-1v5" />
      </>
    ),
  },
  album: {
    d: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
  },
  artist: {
    d: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
  },
  playlist: {
    d: (
      <>
        <path d="M3 6h12M3 11h12M3 16h7" />
        <circle cx="16.5" cy="18" r="2.5" />
        <path d="M19 18V9l3 1" />
      </>
    ),
  },
  note: {
    d: (
      <>
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </>
    ),
  },
  mix: { d: <path d="M2 12h3l3-8 4 16 3-8h7" /> },
  playNext: {
    d: (
      <>
        <path d="M3 6h18M3 12h9M3 18h9" />
        <path d="M16 14.5v6l4.5-3z" />
      </>
    ),
  },
  queueAdd: {
    d: (
      <>
        <path d="M3 6h18M3 12h12M3 18h8" />
        <path d="M18 15v6M15 18h6" />
      </>
    ),
  },
  lyrics: {
    d: (
      <>
        <path d="M4 6h10M4 10h7M4 14h5" />
        <rect x="15" y="9" width="5" height="8" rx="2.5" />
        <path d="M13.5 15a4 4 0 0 0 8 0M17.5 19v2" />
      </>
    ),
  },
  cast: {
    d: (
      <>
        <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
        <path d="M2 12a9 9 0 0 1 8 8" />
        <path d="M2 16a5 5 0 0 1 4 4" />
        <path d="M2 20h.01" />
      </>
    ),
  },
  back: { d: <path d="M15 18l-6-6 6-6" /> },
  chevronRight: { d: <path d="M9 18l6-6-6-6" /> },
  check: { d: <path d="M20 6 9 17l-5-5" /> },
  x: { d: <path d="M18 6 6 18M6 6l12 12" /> },
  dots: {
    solid: true,
    d: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="19" r="2" />
      </>
    ),
  },
  home: {
    d: (
      <>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9" />
      </>
    ),
  },
  library: { d: <path d="M4 4v16M8 7v13M12 7v13M16 6l4 14" /> },
  // 1.4.3: genre (a label tag), drawn to match the 1.3.1 line set
  genre: {
    d: (
      <>
        <path d="M3.5 11.6V4.5a1 1 0 0 1 1-1h7.1a1 1 0 0 1 .7.3l8.2 8.2a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0L3.8 12.3a1 1 0 0 1-.3-.7z" />
        <circle cx="8" cy="8" r="1.4" />
      </>
    ),
  },
};

export type IconName = keyof typeof G;

/** Stroke in viewBox units that lands near 2 CSS px at the rendered size. */
function strokeFor(size: number): number {
  return Math.max(1.1, Math.min(2.2, 48 / size));
}

export function Icon({ name, size = 28, className = '' }: { name: IconName; size?: number; className?: string }) {
  const g = G[name] ?? G.note;
  return g.solid ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      {g.d}
    </svg>
  ) : (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {g.d}
    </svg>
  );
}

/** Placeholder glyph for an item without art: album disc, playlist, artist, track note. */
export function placeholderIcon(item: Item | null | undefined): IconName {
  switch (item?.Type) {
    case 'MusicArtist':
      return 'artist';
    case 'Playlist':
      return 'playlist';
    case 'MusicAlbum':
      return 'album';
    case 'MusicGenre':
      return 'genre';
    default:
      return 'note';
  }
}

// ---- artwork ----

/** Is the element on screen (or within 120px of it)? Lazy art, as in 1.3.1. */
function useNear(ref: { current: HTMLElement | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      es => {
        if (es.some(e => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

export const Artwork = memo(function Artwork({
  item,
  size,
  px = TILE_PX,
  rounded = 'rounded-xl',
  label = '',
  fluid = false,
  round = false,
}: {
  item: Item | null | undefined;
  /** Rendered size in CSS px (ignored when fluid). */
  size: number;
  /** Size requested from Jellyfin. */
  px?: number;
  rounded?: string;
  label?: string;
  fluid?: boolean;
  round?: boolean;
}) {
  const { api } = useCore();
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  const url = useArtUrl(api, item, px, near);
  // Art that is already decoded in memory (or came straight off the disk
  // cache) shows without the fade, so cached screens paint in one frame.
  const [loaded, setLoaded] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());
  // in memory at mount, or off the disk cache within a few frames: no fade
  const instantRef = useRef<boolean | null>(null);
  if (url && instantRef.current === null) instantRef.current = Date.now() - mountedAt.current < 250;
  const instant = !!instantRef.current;
  const shape = round ? 'rounded-full' : rounded;
  return (
    <div
      ref={ref}
      className={`relative shrink-0 overflow-hidden ${shape}`}
      style={fluid ? { width: '100%', aspectRatio: '1 / 1' } : { width: size, height: size }}
    >
      {loaded !== url || !url ? (
        <div className={`absolute inset-0 flex items-center justify-center bg-white/8 text-white/25 ${shape}`} aria-label={label}>
          <Icon name={placeholderIcon(item)} size={Math.round((fluid ? 140 : size) * 0.36)} />
        </div>
      ) : null}
      {url ? (
        <img
          src={url}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(url)}
          className={`absolute inset-0 h-full w-full object-cover ${instant ? '' : 'transition-opacity duration-300'} ${shape} ${
            loaded === url ? 'opacity-100' : 'opacity-0'
          }`}
          alt={label}
        />
      ) : null}
    </div>
  );
});

// ---- buttons / chrome ----

export function IconBtn({
  onClick,
  label,
  children,
  size = 72,
  active = false,
  disabled = false,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
  size?: number;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-focusable={disabled ? undefined : true}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex shrink-0 items-center justify-center rounded-full transition-colors ${
        active ? 'bg-leaf text-black' : 'text-white/85 active:bg-white/15'
      } ${disabled ? 'opacity-30' : ''}`}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  );
}

// 1.4.4: compact one-line header for See-all and detail screens (the tab
// strip is hidden there). 36 px tall: a small back chevron + the title.
// The chevron's touch area is 44 px (an invisible ::before), so the slim
// line does not cost a smaller target.
export const HEADER_H = 36;
export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 pr-4 pl-2" style={{ height: HEADER_H }}>
      {onBack ? <BackChip onBack={onBack} /> : null}
      <h1 className="min-w-0 flex-1 truncate text-lg leading-none font-semibold [text-shadow:0_1px_6px_rgba(0,0,0,0.55)]">{title}</h1>
      {right}
    </div>
  );
}

export function BackChip({ onBack, label = 'Back' }: { onBack: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-focusable
      data-sel="dot"
      onClick={e => {
        e.stopPropagation();
        onBack();
      }}
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/85 before:absolute before:-inset-1.5 before:content-[''] active:bg-white/15"
    >
      <Icon name="back" size={20} />
    </button>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-white/50">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/15 border-t-gold" />
      {label ? <div className="text-xl">{label}</div> : null}
    </div>
  );
}

export function Empty({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 py-6 text-center">
      <div className="text-xl text-white/40">{text}</div>
      {onRetry ? (
        <button
          type="button"
          data-focusable
          onClick={onRetry}
          className="rounded-2xl bg-white/10 px-8 py-4 text-xl font-bold text-white active:bg-white/20"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

// ---- tiles & rows ----

// 1.4.4: "See all" is a text link sized to its text (28 px tall, 8 px
// sides, 9 px radius) and laid out in the row header's flow: no absolute
// position and no translate, so the knob ring (data-sel="link") is placed
// on exactly the box you see and never overlaps the first tile. The touch
// area is padded by an invisible ::before instead of by layout (28 px box,
// 44 px touch).
export function SeeAll({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-focusable
      data-sel="link"
      onClick={onClick}
      className={`relative flex h-7 shrink-0 items-center gap-0.5 rounded-[9px] pr-1 pl-2 text-lg leading-none font-medium text-goldlight before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] active:bg-white/10 ${className}`}
    >
      See all
      <Icon name="chevronRight" size={18} />
    </button>
  );
}

/** Row header: small-caps title left, optional See all right, one 28 px line. */
export function RowHeader({ title, onSeeAll }: { title: string; onSeeAll?: () => void }) {
  return (
    <div className="mb-2 flex h-7 items-center justify-between pr-3.5 pl-5">
      <h2 className="text-xs font-semibold tracking-[0.22em] text-white/80 uppercase">{title}</h2>
      {onSeeAll ? <SeeAll onClick={onSeeAll} /> : null}
    </div>
  );
}

// Horizontal rail section: small-caps title, optional gold "See all", and a
// fixed row of five tiles that evenly fills the full width.
export function Rail({ title, onSeeAll, children }: { title: string; onSeeAll?: () => void; children: ReactNode }) {
  return (
    <section className="mb-6 shrink-0">
      <RowHeader title={title} onSeeAll={onSeeAll} />
      <div className="flex gap-4 overflow-hidden px-5 pb-1 [&>*]:min-w-0 [&>*]:grow-0 [&>*]:basis-[calc((100%-4rem)/5)]">
        {children}
      </div>
    </section>
  );
}

export function SectionTitle({ title, onSeeAll }: { title: string; onSeeAll?: () => void }) {
  return <RowHeader title={title} onSeeAll={onSeeAll} />;
}

export const Tile = memo(function Tile({
  title,
  subtitle,
  item,
  onClick,
  onMenu,
  active,
  round,
}: {
  title: string;
  subtitle?: string;
  item: Item | null;
  onClick: () => void;
  onMenu?: () => void;
  active?: boolean;
  round?: boolean;
}) {
  return (
    <div className="relative min-w-0">
      <button type="button" data-focusable data-sel="tile" onClick={onClick} className="block w-full text-left active:opacity-80">
        <div data-glow-target className={round ? 'rounded-full' : 'rounded-2xl'}>
          <Artwork item={item} size={140} rounded="rounded-2xl" label={title} fluid round={round} />
        </div>
        <div className={`mt-2 truncate text-lg leading-tight font-medium ${active ? 'text-leaf' : ''}`}>{title}</div>
        {subtitle ? <div className="truncate text-base leading-tight text-white/50">{subtitle}</div> : null}
      </button>
      {onMenu ? (
        <button
          type="button"
          aria-label={`More options for ${title}`}
          onClick={e => {
            e.stopPropagation();
            onMenu();
          }}
          className="absolute top-1 right-1 flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white/90 active:bg-black/80"
        >
          <Icon name="dots" size={26} />
        </button>
      ) : null}
    </div>
  );
});

export const GridCard = memo(function GridCard({
  item,
  title,
  subtitle,
  onClick,
  onMenu,
  active,
  round,
}: {
  item: Item | null;
  title: string;
  subtitle?: string;
  onClick: () => void;
  onMenu?: () => void;
  active?: boolean;
  round?: boolean;
}) {
  return (
    <div className="relative cursor-pointer" onClick={onClick} data-focusable data-sel="tile" role="button" tabIndex={-1}>
      <div data-glow-target className={round ? 'rounded-full' : 'rounded-2xl'}>
        <Artwork item={item} size={220} rounded="rounded-2xl" label={title} fluid round={round} />
      </div>
      <div className={`mt-2 truncate px-1 text-lg leading-tight font-semibold ${active ? 'text-leaf' : ''}`}>{title}</div>
      {subtitle ? <div className="truncate px-1 text-base leading-tight text-white/50">{subtitle}</div> : null}
      {onMenu ? (
        <button
          type="button"
          aria-label={`More options for ${title}`}
          onClick={e => {
            e.stopPropagation();
            onMenu();
          }}
          className="absolute top-1.5 right-1.5 flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white/90 active:bg-black/80"
        >
          <Icon name="dots" size={26} />
        </button>
      ) : null}
    </div>
  );
});

export const TrackRow = memo(function TrackRow({
  track,
  onPlay,
  onToggle,
  onMenu,
  showArt = true,
  indexLabel,
  subtitle,
}: {
  track: Item;
  onPlay: () => void;
  onToggle?: () => void;
  onMenu?: () => void;
  showArt?: boolean;
  indexLabel?: string;
  subtitle?: string;
}) {
  const now = useNow();
  const active = now.nowId === track.Id;
  const playing = active && !now.paused;
  const toggle = onToggle ?? onPlay;
  const sub = subtitle ?? [track.Artists?.join(', ') || track.AlbumArtist, track.Album].filter(Boolean).join(' · ');
  return (
    <div className={`flex min-h-16 items-center gap-1 rounded-2xl ${active ? 'bg-leaf/10' : ''}`}>
      {/* 1.3.1's row selection: one knob detent = one song. The highlight
          lands on this row (data-sel="row"), its content nudges right, and
          the knob press plays it. The per-row play and ⋮ buttons are touch
          targets only, so they don't add extra knob stops (1.3.1 had none). */}
      <button
        type="button"
        data-focusable
        data-sel="row"
        data-sel-parent
        onClick={onPlay}
        className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-2xl px-2.5 py-2 text-left active:bg-white/8"
      >
        <span className="sel-shift flex min-w-0 flex-1 items-center gap-3">
          {showArt ? (
            <Artwork item={track} size={56} px={96} rounded="rounded-2xl" label={track.Album} />
          ) : indexLabel ? (
            <span className={`flex w-10 shrink-0 justify-center text-center text-xl ${active ? 'text-leaf' : 'text-white/40'}`}>
              {active ? (
                <span className={`eq ${playing ? '' : 'paused'}`}>
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                indexLabel
              )}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span className={`sel-title block truncate text-xl leading-tight ${active ? 'text-leaf' : ''}`}>{track.Name}</span>
            {sub ? <span className="block truncate text-base leading-tight text-white/50">{sub}</span> : null}
          </span>
          <span className="shrink-0 text-base text-white/40">{fmtTime((track.RunTimeTicks ?? 0) / 10_000)}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`${playing ? 'Pause' : 'Play'} ${track.Name}`}
        onClick={toggle}
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white/70 active:bg-white/15"
      >
        <Icon name={playing ? 'pause' : 'play'} size={26} />
      </button>
      {onMenu ? (
        <button
          type="button"
          aria-label={`More options for ${track.Name}`}
          onClick={onMenu}
          className="mr-1 flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white/70 active:bg-white/15"
        >
          <Icon name="dots" size={26} />
        </button>
      ) : null}
    </div>
  );
});

// o-music's bare-glyph button: the padding is the hit area; the tap
// keyframes replay on every press.
export function Ghost({
  label,
  tint,
  onClick,
  disabled,
  focusDefault,
  className = '',
  children,
}: {
  label: string;
  tint?: string;
  onClick: () => void;
  disabled?: boolean;
  focusDefault?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // Replay the tap keyframes on every press without remounting the glyph:
  // remounting it between pointerdown and pointerup (finch-remote's key
  // trick) detaches the press target, and Chromium then drops the click.
  const glyph = useRef<HTMLSpanElement>(null);
  const replay = () => {
    const el = glyph.current;
    if (!el) return;
    el.classList.remove('animate-tap');
    void el.offsetWidth;
    el.classList.add('animate-tap');
  };
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-focusable={disabled ? undefined : true}
      data-focus-default={focusDefault ? true : undefined}
      data-sel="dot"
      onPointerDown={replay}
      onClick={onClick}
      style={tint ? { color: tint } : undefined}
      className={`-m-3 shrink-0 p-3 text-[#efefef] transition-[transform,color] duration-300 ease-spring active:scale-90 disabled:opacity-30 ${className}`}
    >
      <span ref={glyph} className="grid place-items-center">
        {children}
      </span>
    </button>
  );
}

// ---- progress bar with tap/drag seek ----
//
// 1.4.1: no per-frame JS. Twice a second (1.3.1's tick) the fill and dot are
// handed the position half a second ahead with a 500 ms linear transform
// transition, so the compositor moves them smoothly in between; the time
// labels are written only when the second changes. React renders this
// component only on a poll, a seek or a drag.

export function ProgressBar({
  dot = true,
  interactive = true,
  showTimes = true,
  fill,
}: {
  dot?: boolean;
  interactive?: boolean;
  showTimes?: boolean;
  fill?: string;
}) {
  const pb = usePb();
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
  const remRef = useRef<HTMLSpanElement>(null);
  // While the finger is down the bar follows it locally; the player hears
  // about the seek exactly once, on release.
  const [dragMs, setDragMs] = useState<number | null>(null);
  const dur = pb.loadingTrack ? 0 : pb.durationMs;
  const running = !pb.paused && !pb.loadingTrack && dragMs === null;
  const posNow = pb.positionNow;

  const paint = (ms: number, aheadMs: number) => {
    const at = Math.min(dur, ms + aheadMs);
    const r = dur > 0 ? Math.min(1, Math.max(0, at / dur)) : 0;
    const tr = aheadMs > 0 ? `transform ${aheadMs}ms linear` : 'none';
    const f = fillRef.current;
    if (f) {
      f.style.transition = tr;
      f.style.transform = `scaleX(${r})`;
    }
    const d = dotRef.current;
    if (d) {
      d.style.transition = tr;
      d.style.transform = `translateX(${r * 100}%)`;
    }
    const sec = Math.floor(ms / 1000);
    if (curRef.current && curRef.current.dataset.s !== String(sec) + ':' + dur) {
      curRef.current.dataset.s = String(sec) + ':' + dur;
      curRef.current.textContent = fmtTime(ms);
      if (remRef.current) remRef.current.textContent = `-${fmtTime(Math.max(0, dur - ms))}`;
    }
  };

  // every render (poll / seek / drag): snap to the exact position
  useLayoutEffect(() => {
    paint(dragMs ?? (pb.loadingTrack ? 0 : posNow()), 0);
  });

  useEffect(() => {
    if (!running) return;
    const step = () => paint(posNow(), 500);
    step();
    const id = window.setInterval(step, 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, dur, posNow]);

  const msFromEvent = (clientX: number): number | null => {
    const el = barRef.current;
    if (!el || dur <= 0) return null;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return p * dur;
  };
  const tint = fill ? { background: fill } : undefined;

  return (
    <div className="w-full">
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        className={`relative -my-3 flex h-6 w-full items-center py-3 ${interactive ? 'cursor-pointer touch-none' : 'pointer-events-none'}`}
        onPointerDown={
          interactive
            ? e => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                const ms = msFromEvent(e.clientX);
                if (ms !== null) setDragMs(ms);
              }
            : undefined
        }
        onPointerMove={
          interactive
            ? e => {
                if (dragMs === null) return;
                const ms = msFromEvent(e.clientX);
                if (ms !== null) setDragMs(ms);
              }
            : undefined
        }
        onPointerUp={
          interactive
            ? e => {
                if (dragMs === null) return;
                const ms = msFromEvent(e.clientX) ?? dragMs;
                setDragMs(null);
                if (ms !== null) pb.act.seekTo(ms);
              }
            : undefined
        }
        onPointerCancel={interactive ? () => setDragMs(null) : undefined}
      >
        <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 overflow-hidden rounded-full bg-white/18">
          {/* 1.4.2: the colour sits on an inner layer so it can crossfade
              (the outer one's transition is rewritten by paint()). */}
          <div ref={fillRef} className="h-full w-full origin-left" style={{ transform: 'scaleX(0)' }}>
            <div className={`h-full w-full rounded-full transition-[background-color] duration-500 ${fill ? '' : 'bg-gold'}`} style={tint} />
          </div>
        </div>
        {dot ? (
          <div ref={dotRef} className="pointer-events-none absolute inset-y-0 left-0 w-full" style={{ transform: 'translateX(0%)' }}>
            <div
              className={`absolute top-1/2 left-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow transition-[background-color] duration-500 ${dragMs !== null ? 'scale-150' : ''} ${
                fill ? '' : 'bg-goldlight'
              }`}
              style={tint}
            />
          </div>
        ) : null}
        {dragMs !== null && dur > 0 ? (
          <div
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-md bg-white px-2 py-0.5 font-mono text-xs font-semibold text-black shadow-lg"
            style={{ left: `${(dragMs / dur) * 100}%` }}
          >
            {fmtTime(dragMs)}
          </div>
        ) : null}
      </div>
      {showTimes ? (
        <div className="mt-2 flex justify-between font-mono text-[0.75rem] text-white/35 tabular-nums">
          <span ref={curRef}>0:00</span>
          <span ref={remRef}>-0:00</span>
        </div>
      ) : null}
    </div>
  );
}

// ---- context menu (bottom sheet) ----

export interface MenuAction {
  label: string;
  icon: IconName;
  run: () => void;
  danger?: boolean;
}

export function MenuSheet({ title, actions, onClose }: { title: string; actions: MenuAction[]; onClose: () => void }) {
  return (
    <FocusScope>
      <div className="absolute inset-0 z-50 flex animate-fade items-end justify-center bg-black/70" onClick={onClose}>
        <div className="max-h-[85%] w-full animate-sheet overflow-y-auto" onClick={e => e.stopPropagation()}>
          <GlassPanel className="rounded-t-3xl p-4 pb-6">
            <div className="mb-3 truncate px-2 text-2xl font-semibold">{title}</div>
            {actions.map(a => (
              <button
                key={a.label}
                type="button"
                data-focusable
                data-sel="row"
                onClick={() => {
                  onClose();
                  a.run();
                }}
                className={`mb-2 flex h-18 w-full items-center gap-4 rounded-2xl px-4 text-left text-2xl active:bg-white/10 ${
                  a.danger ? 'text-red-400' : ''
                }`}
              >
                <span className="sel-shift flex items-center gap-4">
                  <Icon name={a.icon} size={28} />
                  {a.label}
                </span>
              </button>
            ))}
            <button
              type="button"
              data-focusable
              data-sel="row"
              onClick={onClose}
              className="mt-2 flex h-18 w-full items-center justify-center gap-3 rounded-2xl bg-white/10 text-2xl font-medium active:bg-white/20"
            >
              <Icon name="x" size={26} /> Cancel
            </button>
          </GlassPanel>
        </div>
      </div>
    </FocusScope>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ title: string; actions: MenuAction[] } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const sheet = menu ? <MenuSheet title={menu.title} actions={menu.actions} onClose={close} /> : null;
  return useMemo(() => ({ open: setMenu, close, isOpen: !!menu, sheet }), [sheet, menu, close]);
}

// ---- motion & skeletons ----

export function Rise({ i = 0, className = '', children }: { i?: number; className?: string; children: ReactNode }) {
  return (
    <div className={`animate-rise ${className}`} style={{ animationDelay: `${Math.min(i, 7) * 45}ms` }}>
      {children}
    </div>
  );
}

export function SkeletonTile() {
  return (
    <div className="min-w-0" aria-hidden>
      <div className="skeleton aspect-square w-full rounded-2xl" />
      <div className="skeleton mt-2 h-6 w-4/5 rounded-md" />
      <div className="skeleton mt-1.5 h-5 w-3/5 rounded-md" />
    </div>
  );
}

export function RailSkeleton() {
  return (
    <section className="mb-7" aria-hidden>
      <div className="skeleton mx-5 mb-3 h-4 w-40 rounded" />
      <div className="flex gap-4 overflow-hidden px-5 [&>*]:min-w-0 [&>*]:grow-0 [&>*]:basis-[calc((100%-4rem)/5)]">
        {[0, 1, 2, 3, 4].map(i => (
          <SkeletonTile key={i} />
        ))}
      </div>
    </section>
  );
}

export function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <SkeletonTile key={i} />
      ))}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex min-h-[72px] items-center gap-3 px-3 py-2" aria-hidden>
      <div className="skeleton h-14 w-14 shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1">
        <div className="skeleton h-6 w-2/3 rounded-md" />
        <div className="skeleton mt-1.5 h-5 w-1/3 rounded-md" />
      </div>
    </div>
  );
}

// ---- ambient blurred-artwork backdrop ----
//
// 1.4.1: the art is blurred once into a 36px image (blur.ts) and scaled up,
// instead of a live 64px CSS blur over a 1.5x full-screen image.

type AmbientLayer = { url: string; accent: string | null };

/** Blurred art behind a scrim, crossfading on change (finch-remote AmbientArt look). */
export const AmbientArt = memo(function AmbientArt({
  url: srcUrl,
  accent,
  height = 320,
  fixed = false,
  vibrant = false,
  fullHeight = false,
  softBottom = false,
}: {
  url: string | null;
  accent?: string | null;
  height?: number;
  fixed?: boolean;
  vibrant?: boolean;
  fullHeight?: boolean;
  softBottom?: boolean;
}) {
  const url = useBlurred(srcUrl);
  const [displayed, setDisplayed] = useState<AmbientLayer | null>(null);
  const [incoming, setIncoming] = useState<AmbientLayer | null>(null);
  const [incomingOn, setIncomingOn] = useState(false);
  const promoteRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!url) return;
    const a = accent ?? null;
    if (displayed && displayed.url === url) {
      if (displayed.accent !== a) setDisplayed({ url, accent: a });
      return;
    }
    if (!displayed) {
      // first paint (e.g. cached art at start-up): no fade
      setDisplayed({ url, accent: a });
      return;
    }
    if (!incoming || incoming.url !== url || incoming.accent !== a) {
      setIncoming({ url, accent: a });
      setIncomingOn(false);
    }
  }, [url, accent, displayed, incoming]);

  useEffect(() => {
    if (!incoming) return;
    let raf = 0;
    let done = false;
    const promote = () => {
      if (done) return;
      done = true;
      setDisplayed(incoming);
      setIncoming(null);
      setIncomingOn(false);
    };
    promoteRef.current = promote;
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setIncomingOn(true));
    });
    const t = window.setTimeout(promote, 2000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [incoming]);

  if (!displayed && !incoming) return null;
  const artOpacity = vibrant ? 0.7 : 0.4;
  const accentOpacity = vibrant ? 0.5 : 0.3;
  const renderLayer = (l: AmbientLayer, isIncoming: boolean, on: boolean) => (
    <div
      key={l.url}
      className={`absolute inset-0 ${isIncoming ? 'transition-opacity duration-500' : ''}`}
      style={{ opacity: isIncoming ? (on ? 1 : 0) : 1 }}
      onTransitionEnd={
        isIncoming
          ? e => {
              if (e.propertyName === 'opacity') promoteRef.current();
            }
          : undefined
      }
    >
      <img src={l.url} className="h-full w-full object-cover" style={{ opacity: artOpacity }} draggable={false} alt="" />
      {l.accent ? (
        <div
          className="absolute inset-0"
          style={{ opacity: accentOpacity, background: `radial-gradient(120% 90% at 50% 0%, ${l.accent} 0%, transparent 70%)` }}
        />
      ) : null}
    </div>
  );
  return (
    <div
      className={`pointer-events-none ${fixed ? 'fixed' : 'absolute'} ${fullHeight ? 'inset-0' : 'inset-x-0 top-0'} overflow-hidden`}
      style={{
        ...(fullHeight ? undefined : { height }),
        ...(softBottom
          ? {
              maskImage: 'linear-gradient(to bottom, black 65%, transparent 100%)',
              WebkitMaskImage: 'linear-gradient(to bottom, black 65%, transparent 100%)',
            }
          : undefined),
      }}
      aria-hidden
    >
      {displayed ? renderLayer(displayed, false, true) : null}
      {incoming ? renderLayer(incoming, true, incomingOn) : null}
      <div
        className={`absolute inset-0 bg-gradient-to-b from-transparent ${
          fullHeight ? 'via-zinc-950/40 to-zinc-950' : vibrant ? 'via-zinc-950/10 to-zinc-950/70' : 'via-zinc-950/30 to-zinc-950'
        }`}
      />
    </div>
  );
});

// One backdrop behind the transparent tab strip, rendered at App level; each
// tab publishes its art here. Null publishes are ignored so a loading tab
// never blanks the previous tab's backdrop.
type AmbientState = { url: string | null; accent: string | null };
let ambientState: AmbientState = { url: null, accent: null };
const ambientListeners = new Set<() => void>();

export function publishAmbient(url: string | null, accent: string | null): void {
  if (url === null) return;
  if (ambientState.url === url && ambientState.accent === accent) return;
  ambientState = { url, accent };
  ambientListeners.forEach(l => l());
}

const subscribeAmbient = (cb: () => void) => {
  ambientListeners.add(cb);
  return () => {
    ambientListeners.delete(cb);
  };
};
export function useAmbient(): AmbientState {
  return useSyncExternalStore(subscribeAmbient, () => ambientState);
}

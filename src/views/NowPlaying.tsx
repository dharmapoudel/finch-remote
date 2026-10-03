import { useEffect, useRef, useState, type JSX, type TouchEvent as RTouchEvent } from 'react';
import { Ghost, Icon, IconBtn, ProgressBar, TransportGlyph, readBlurSig, useArt, useCachedArt, usePlayer, usePortrait, warmArt } from '../components';
import { useAccent, type Accent } from '../accent';
import type { LyricLineVM } from '../jellyfin';
import { player } from '../player';
import { knob } from '../fx/knob';
import { RemoteSheet } from '../RemoteSheet';
import type { ViewProps } from '../nav';

// ThumbHash-style hero: no WebGL, no bloom. The 160px art (already fetched
// for the backdrop/tint) is blown up and heavily blurred as the placeholder
// — visually what a decoded ThumbHash looks like (a real ThumbHash needs
// server-side hashes, which Jellyfin doesn't serve; blurring the small art
// we already hold is the honest equivalent). The 512px hero fades in over
// it when it arrives. Keyed by src so a track change replays the reveal.
export function ThumbHashHero({
  lowSrc,
  highSrc,
  alt,
}: {
  lowSrc: string | null;
  highSrc: string | null;
  alt: string;
}): JSX.Element {
  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-950">
      {lowSrc ? (
        <img
          key={lowSrc}
          src={lowSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full scale-125 object-cover blur-3xl"
        />
      ) : null}
      {highSrc ? (
        <img
          key={highSrc}
          src={highSrc}
          alt={alt}
          draggable={false}
          className="animate-hero-in absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </div>
  );
}

// Lyrics view state. Shape borrowed from Ousa-Music-Player's useLyrics:
// loading / none / timed / plain are all ordinary outcomes, none an error.
type LyricsState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'synced'; lines: LyricLineVM[] }
  | { state: 'plain'; lines: LyricLineVM[] };

// Signal the Glass Overlay (injected into this same document) to hold its
// ambient screensaver off while the Now Playing screen is up. The overlay
// raises the ambient screen after N seconds with no input events, but here
// the user is watching, not touching. Sticky window flag first (the overlay
// may boot after this view mounts), then the DOM event for changes; both
// are cleared on unmount so the screensaver can return afterwards.
const AMBIENT_INHIBIT_EVENT = 'bridgething:ambient-inhibit';
const AMBIENT_INHIBIT_FLAG = '__bridgethingAmbientInhibit';

function setAmbientInhibit(inhibit: boolean): void {
  try {
    (window as unknown as Record<string, unknown>)[AMBIENT_INHIBIT_FLAG] = inhibit;
  } catch {
    /* a locked-down window object shouldn't break playback */
  }
  window.dispatchEvent(new CustomEvent(AMBIENT_INHIBIT_EVENT, { detail: { inhibit } }));
}

// The line that should be lit right now: the last one that has started.
// Binary search, since a synced track can carry hundreds of lines.
function activeLineIndex(lines: LyricLineVM[], posMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= posMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function SyncedLyrics({ lines }: { lines: LyricLineVM[] }) {
  usePlayer();
  const [, force] = useState(0);
  const lineRefs = useRef(new Map<number, HTMLButtonElement>());
  const lastActive = useRef(-2);

  // Re-evaluate the active line a few times a second while playing. The
  // player extrapolates position locally between daemon snapshots, so
  // positionNow() stays fresh without any snapshot traffic.
  useEffect(() => {
    if (!player.intentPlaying) return;
    const id = window.setInterval(() => force(n => n + 1), 250);
    return () => window.clearInterval(id);
  }, [player.intentPlaying]);

  const active = activeLineIndex(lines, player.positionNow());

  useEffect(() => {
    if (active !== lastActive.current && active >= 0) {
      lastActive.current = active;
      // Smooth-glide to the new line; the old instant jump is what made
      // the lyrics feel out of sync with the audio.
      lineRefs.current.get(active)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  return (
    <div className="h-full w-full overflow-y-auto px-6 py-8">
      {lines.map((l, i) => {
        const isActive = i === active;
        return (
          <button
            key={i}
            type="button"
            ref={el => {
              if (el) lineRefs.current.set(i, el);
              else lineRefs.current.delete(i);
            }}
            onClick={() => void player.seekTo(l.startMs)}
            className={`block w-full rounded-2xl px-4 py-3 text-center transition-colors active:bg-white/10 ${
              isActive ? 'text-3xl font-bold text-goldlight' : 'text-2xl font-medium text-white/45'
            }`}
          >
            {l.text}
          </button>
        );
      })}
    </div>
  );
}

// Pure renderer — the lyrics for the current track are fetched once in
// NowPlaying (per-track cached in the client), so the toggle can dim when
// the track has none and the tab opens instantly.
function LyricsPanel({ lyrics }: { lyrics: LyricsState }) {
  if (lyrics.state === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center text-2xl text-white/50">
        Loading lyrics…
      </div>
    );
  }
  if (lyrics.state === 'none') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Icon name="note" size={64} className="text-white/20" />
        <div className="text-2xl font-semibold text-white/70">No lyrics for this track</div>
        <div className="text-lg leading-snug text-white/40">
          Jellyfin shows lyrics embedded in the file's tags — rescan the library after tagging.
        </div>
      </div>
    );
  }
  if (lyrics.state === 'plain') {
    return (
      <div className="h-full w-full overflow-y-auto px-8 py-6">
        <div className="text-center text-2xl leading-relaxed whitespace-pre-line text-white/85">
          {lyrics.lines.map(l => l.text).join('\n')}
        </div>
      </div>
    );
  }
  return <SyncedLyrics lines={lyrics.lines} />;
}

// Device clock for the top of the info panel, o-music style: 15px mono with
// a blinking colon, left-aligned like the reference arrangement.
function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const parts = new Date(now)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    .split(':');
  const colon = (
    <span
      className="transition-opacity duration-150"
      style={{ opacity: Math.floor(now / 500) % 2 === 0 ? 1 : 0.2 }}
    >
      :
    </span>
  );
  return (
    <span className="shrink-0 font-mono tabular-nums text-white/35" style={{ fontSize: 15 }}>
      {parts[0]}
      {colon}
      {parts[1]}
      {colon}
      {parts[2]}
    </span>
  );
}

// Right-hand info column, ported from o-music's Widget landscape layout:
// clock top-left, titles, seek bar + times, transport, and heart + lyrics
// icons where o-music puts its volume bar. The background is the blurred
// album art washed with a color pulled off the cover.
function InfoPanel({
  isFavorite,
  onToggleFav,
  lyricsVisible,
  onToggleLyrics,
  lyricsSupported,
  hasLyrics,
  accent,
  bgArtUrl,
  onOpenRemote,
}: {
  isFavorite: boolean;
  onToggleFav: () => void;
  lyricsVisible: boolean;
  onToggleLyrics: () => void;
  lyricsSupported: boolean | null;
  hasLyrics: boolean;
  accent: Accent | null;
  bgArtUrl: string | null;
  onOpenRemote: () => void;
}) {
  usePlayer();
  const portrait = usePortrait();
  // o-music's landscape card is 280px wide against a 480px tall screen, so
  // every row it holds comes down a size; portrait keeps the larger metrics.
  const small = !portrait;
  const t = player.current();

  if (!t) return null;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {bgArtUrl ? (
        <img
          src={bgArtUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl brightness-[0.4]"
        />
      ) : null}
      <div
        className="absolute inset-0 backdrop-blur-md"
        style={{
          background: accent
            ? `linear-gradient(155deg, color-mix(in oklab, ${accent.fill} 18%, rgba(10,12,14,0.72)), rgba(10,12,14,0.72) 78%)`
            : 'rgba(10,12,14,0.72)',
        }}
      />
      <div className="relative flex min-h-0 flex-1 flex-col px-5 py-4">
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          {/* the track takes the space above; the controls hold the bottom edge whatever is left */}
          <div className="flex min-h-0 flex-1 flex-col py-1">
            <div className="flex shrink-0 items-center justify-between">
              <Clock />
              <button
                type="button"
                aria-label="Choose playback device"
                onClick={onOpenRemote}
                className="rounded-full border border-white/15 px-3 py-1.5 text-sm text-white/65 active:bg-white/10"
              >
                {player.remoteActive ? `via ${player.remoteClient}` : 'This device'}
              </button>
            </div>

            {/* titles block: fixed 202px so the seekbar below NEVER moves
                (same position as 1.1.29); titles vertically centered inside,
                nudged slightly down */}
            <div className="flex h-[202px] shrink-0 flex-col justify-center pt-[24px]">
              <div className="min-w-0 shrink-0">
              <div
                className={`line-clamp-3 font-display font-semibold leading-[1.2] tracking-display text-[#efefef] ${
                  small ? 'text-[1.75rem]' : 'text-[1.875rem]'
                }`}
              >
                {t.name}
              </div>
              <div className="mt-1.5 line-clamp-2 text-[1.25rem] text-white/55">{t.artist}</div>
              {player.remoteActive ? (
                <div className="mt-1 text-[1.05rem] text-leaf">Playing on {player.remoteDevice}</div>
              ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1" aria-hidden="true" />
            {/* seekbar centered where the controls bar used to sit, nudged down 20px */}
            <div className="flex min-h-0 flex-[2] flex-col justify-center pt-[40px]">
              <div className="shrink-0">
                <ProgressBar onSeek={ms => void player.seekTo(ms)} />
              </div>
            </div>
          </div>

          {/* bottom row: lyrics, prev/play/next, heart — all in one row */}
          <div className="mb-[15px] flex w-full shrink-0 items-center justify-between">
              {lyricsSupported !== false ? (
                <Ghost
                  label={
                    hasLyrics
                      ? lyricsVisible
                        ? 'Hide lyrics'
                        : 'Show lyrics'
                      : 'No lyrics for this track'
                  }
                  disabled={!hasLyrics}
                  onClick={onToggleLyrics}
                  tint={lyricsVisible ? '#34d399' : undefined}
                  className={lyricsVisible ? '' : 'opacity-40'}
                >
                  <Icon name="lyrics" size={24} />
                </Ghost>
              ) : (
                <div className="w-6 shrink-0" aria-hidden="true" />
              )}
              <Ghost label="Previous" onClick={() => void player.prev()}>
                <TransportGlyph
                  name="skip"
                  className={small ? 'h-8 w-8 -scale-x-100' : 'h-7 w-7 -scale-x-100'}
                />
              </Ghost>
              <Ghost
                label={player.intentPlaying ? 'Pause' : 'Play'}
                onClick={() => void player.toggle()}
                tint={accent?.fill}
                focusDefault
              >
                {player.loading ? (
                  <span className="block h-9 w-9 animate-spin rounded-full border-4 border-white/15 border-t-white/85" />
                ) : (
                  <span
                    key={player.intentPlaying ? 'pause' : 'play'}
                    className="grid animate-pop place-items-center"
                  >
                    <TransportGlyph
                      name={player.intentPlaying ? 'pause' : 'play'}
                      className={small ? 'h-9 w-9' : 'h-8 w-8'}
                    />
                  </span>
                )}
              </Ghost>
              <Ghost label="Next" onClick={() => void player.next()}>
                <TransportGlyph name="skip" className={small ? 'h-8 w-8' : 'h-7 w-7'} />
              </Ghost>
              <Ghost
                label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={onToggleFav}
                tint={isFavorite ? '#34d399' : undefined}
                className={isFavorite ? '' : 'opacity-40'}
              >
                <Icon name={isFavorite ? 'heartFill' : 'heart'} size={24} />
              </Ghost>
            </div>

            {player.error ? (
              <div className="shrink-0 px-1 pt-1 text-center">
                <div className="text-xl text-red-300">{player.error}</div>
                {player.errorDetail ? (
                  <div className="mt-1 text-sm leading-snug text-white/35">{player.errorDetail}</div>
                ) : null}
              </div>
            ) : player.external ? (
              <div className="shrink-0 pt-1 text-xl text-white/50">Another app is playing on the phone.</div>
            ) : null}
        </div>
      </div>
    </div>
  );
}

export default function NowPlaying({
  jf,
  nav,
  onMinimize,
  onDragProgress,
}: ViewProps & {
  onMinimize: (target?: 'mini' | 'sliver') => void;
  onDragProgress?: (progress: number) => void;
}) {
  const playerRev = usePlayer();
  const art = useArt();
  const portrait = usePortrait();
  const [remoteOpen, setRemoteOpen] = useState(false);
  // Bidirectional sync: while Now Playing is visible, subscribe to the
  // Jellyfin WebSocket for instant push updates when the track changes
  // directly in the phone app. Falls back to a poll if the socket isn't open.
  useEffect(() => {
    const unsub = player.subscribeWsPushes();
    // If WS wasn't available, do one immediate poll to catch up.
    if (player.remoteActive) player.refreshRemoteNow();
    return unsub;
  }, []);
  // Auto-prompt for a playback device when the player needs one (no remote
  // found on startup and local audio not explicitly allowed).
  useEffect(() => {
    if (player.needsDeviceChoice) setRemoteOpen(true);
  }, [playerRev]);
  useEffect(() => {
    if (!remoteOpen && player.needsDeviceChoice) {
      // Sheet dismissed without choosing: clear the flag so it doesn't
      // re-open on every render. The user can reopen via the device button.
      player.needsDeviceChoice = false;
    }
  }, [remoteOpen]);
  const [lyricsSupported, setLyricsSupported] = useState<boolean | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({ state: 'loading' });
  // Sticky preference owned by the player (persisted across restarts):
  // usePlayer() above re-renders us when it changes.
  const lyricsTab = player.lyricsTab;
  const t = player.current();
  const trackId = t?.id;
  const artPanelRef = useRef<HTMLDivElement>(null);

  // ---- knob: volume on this screen ----
  // The knob drives the phone's volume while this view is up (no focus
  // order, no scrub): detents are handled by App's volume nudger, tap
  // toggles playback, and long-press is a no-op (volume is already on
  // the knob, so there is no separate volume mode to enter).
  useEffect(() => {
    knob.setMode('nowplaying');
    return () => {
      knob.setMode('scroll');
    };
  }, []);

  // While this view is mounted the Now Playing screen is up: hold the Glass
  // Overlay's ambient screensaver off (see setAmbientInhibit above) until we
  // unmount.
  useEffect(() => {
    setAmbientInhibit(true);
    const onHide = (): void => setAmbientInhibit(false);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      setAmbientInhibit(false);
    };
  }, []);

  // The lyrics tab is a sticky preference, not per-track state: it stays on
  // across track changes, and the panel simply shows the album art for
  // tracks that have no lyrics, switching back to lyrics on its own when a
  // track with lyrics comes up.
  const hasLyrics = lyrics.state === 'synced' || lyrics.state === 'plain';
  const showLyrics = lyricsTab && hasLyrics;

  // Draggable sheet: same panel morphs from full → mini → sliver.
  // The sheet follows the finger 1:1. Within the sheet, three layers
  // crossfade: the full UI fades out as the mini bar (real MiniBar
  // component, pixel-identical) fades in at the sheet's top — which lands
  // at the screen bottom when the sheet is dragged to the mini position.
  // The sliver is the same ProgressBar clipped to 2px. No panel swap
  // during drag; the handoff to App.tsx's persistent bar happens after
  // snap, at the identical position.
  const sheetRef = useRef<HTMLDivElement>(null);
  const fullLayerRef = useRef<HTMLDivElement>(null);
  const miniLayerRef = useRef<HTMLDivElement>(null);
  const sliverLayerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);
  // Refs for staggered morph elements
  const miniSeekRef = useRef<HTMLDivElement>(null);
  const miniTextRef = useRef<HTMLDivElement>(null);
  const miniPlayRef = useRef<HTMLDivElement>(null);
  const miniNextRef = useRef<HTMLDivElement>(null);
  // Refs for TRUE morph: the actual fullscreen elements that transform
  const morphArtRef = useRef<HTMLDivElement>(null);

  const MINI_H = 84;
  const SLIVER_H = 2;

  const updateLayers = (dy: number): void => {
    const H = window.innerHeight;
    const miniY = H - MINI_H;
    const sliverY = H - SLIVER_H;
    // 0→1 as we drag from full to mini position
    const pMini = Math.min(1, Math.max(0, dy / miniY));
    // 0→1 as we drag from mini to sliver position
    const pSliver = Math.min(1, Math.max(0, (dy - miniY) / Math.max(1, sliverY - miniY)));

    const full = fullLayerRef.current;
    const mini = miniLayerRef.current;
    const sliver = sliverLayerRef.current;
    
    // Full UI: fade out with slight scale down for morph feel.
    // Stagger: fade quickly in first 60% of drag.
    if (full) {
      const pFull = Math.min(1, pMini * 1.4);
      full.style.opacity = String(1 - pFull);
      full.style.transform = `scale(${1 - pMini * 0.05})`;
    }
    
    // Mini elements: staggered fade in.
    // The morph: elements toggle/fade within the same panel.
    // Seekbar first, then art, text, controls.
    const setOp = (ref: React.RefObject<HTMLDivElement | null>, p: number) => {
      const el = ref.current;
      if (el) el.style.opacity = String(Math.max(0, Math.min(1, p)));
    };
    // Staggered thresholds: each element fades in over a sub-range of pMini
    setOp(miniSeekRef, (pMini - 0.1) / 0.3);  // 0.1→0.4
    // Artwork uses TRUE MORPH (geometric transform of the fullscreen element),
    // not a fade. The miniArtRef fade is disabled — the morph handles it.
    setOp(miniTextRef, (pMini - 0.4) / 0.3);    // 0.4→0.7
    setOp(miniPlayRef, (pMini - 0.55) / 0.3);   // 0.55→0.85
    setOp(miniNextRef, (pMini - 0.65) / 0.3);   // 0.65→0.95

    // TRUE MORPH: the actual fullscreen artwork element scales and moves
    // to the mini position. Same DOM node, geometric transform — not a fade.
    if (morphArtRef.current) {
      const scale = 1 - pMini * 0.9; // 1 → 0.1 (440px → 44px)
      const tx = 16 * pMini; // 0 → 16px
      const ty = 30 * pMini; // 0 → 30px
      morphArtRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      morphArtRef.current.style.borderRadius = `${12 * pMini}px`;
    }
    
    // Mini container: ensure it's visible when any element is.
    if (mini) mini.style.opacity = pMini > 0.05 ? '1' : '0';
    
    // Sliver: fade in as we go from mini to sliver, mini fades out.
    if (sliver) sliver.style.opacity = String(pSliver);
    if (mini && pSliver > 0) {
      // Fade the mini elements out as sliver takes over
      const fade = 1 - pSliver;
      setOp(miniSeekRef, ((pMini - 0.1) / 0.3) * fade);
      // miniArtRef removed — artwork uses TRUE MORPH, not fade
      setOp(miniTextRef, ((pMini - 0.4) / 0.3) * fade);
      setOp(miniPlayRef, ((pMini - 0.55) / 0.3) * fade);
      setOp(miniNextRef, ((pMini - 0.65) / 0.3) * fade);
    }
  };

  const onTouchStart = (e: RTouchEvent): void => {
    // Touches inside the lyrics panel scroll the lyrics instead of dragging.
    if (showLyrics && artPanelRef.current?.contains(e.target as Node)) return;
    const p = e.touches[0];
    dragRef.current = { startY: p.clientY, dy: 0 };
    const el = sheetRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.willChange = 'transform';
    }
  };
  const onTouchMove = (e: RTouchEvent): void => {
    const d = dragRef.current;
    const el = sheetRef.current;
    if (!d || !el) return;
    const p = e.touches[0];
    const dy = Math.max(0, p.clientY - d.startY);
    d.dy = dy;
    el.style.transform = `translateY(${dy}px)`;
    updateLayers(dy);
    // Fade the queue pill out as we drag down (it lives in App.tsx).
    onDragProgress?.(Math.min(1, dy / (window.innerHeight * 0.3)));
  };
  const onTouchEnd = (): void => {
    const d = dragRef.current;
    const el = sheetRef.current;
    dragRef.current = null;
    if (!d || !el) return;
    const H = window.innerHeight;
    const miniY = H - MINI_H;
    const sliverY = H - SLIVER_H;
    const dy = d.dy;
    // Snap to nearest: full, mini, or sliver.
    let targetY: number;
    let target: 'mini' | 'sliver' | null;
    if (dy < miniY * 0.5) {
      targetY = 0;
      target = null; // snap back to full
    } else if (dy < (miniY + sliverY) / 2) {
      targetY = miniY;
      target = 'mini';
    } else {
      targetY = sliverY;
      target = 'sliver';
    }
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transition = `transform 0.35s ${ease}`;
    el.style.willChange = 'auto';
    el.style.transform = `translateY(${targetY}px)`;
    updateLayers(targetY);
    if (target) {
      // Let the snap animation finish, then hand off to the persistent
      // mini/sliver in App.tsx — at the identical position, so no jump.
      window.setTimeout(() => onMinimize(target), 340);
    } else {
      // Snapped back to full: reset layers and restore the queue pill.
      onDragProgress?.(0);
      window.setTimeout(() => updateLayers(0), 350);
    }
  };

  // Full-bleed artwork for the hero panel, served from the shared blob cache.
  // A small copy doubles as the blurred lyrics backdrop (cheap to blur).
  // TWO PASSES, in this order: the 160px art downloads FIRST and paints the
  // blurred ThumbHash placeholder immediately; only once it is in hand (or
  // failed) does the 512px hero start. This ordering is load-bearing: the
  // art lane is strictly serial, so requesting the 512 first would block
  // the 160 behind it and the screen would stay dark until the big download
  // finished — exactly what shuffle-play showed on a cold cache.
  const { url: bgArt, failed: bgFailed } = useCachedArt(t ? (art?.trackArt(t, 160) ?? null) : null);
  const heroSrc = t && (bgArt || bgFailed) ? (art?.trackArt(t, 512) ?? null) : null;
  const { url: heroArt } = useCachedArt(heroSrc);

  // Instant placeholder: a stored 16x16 blur signature paints with zero
  // network while the 160px downloads (one local kv lookup, ~ms). Keyed by
  // track id, falling back to the album id — the same preference the art
  // itself uses. Cleared on track change so the old track's colors never
  // linger; the 160px blur takes over seamlessly when it lands.
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  useEffect(() => {
    setSigUrl(null);
    if (!t) return;
    let dead = false;
    void readBlurSig([t.id, t.albumId]).then(u => {
      if (!dead) setSigUrl(u);
    });
    return () => {
      dead = true;
    };
  }, [trackId, t?.albumId]);

  // Shuffle/skipping ahead stays instant: pre-warm the next few tracks'
  // small art at back priority. By the time the user (or auto-advance) gets
  // there, the first pass is served from cache and only the 512 needs the
  // network. Re-runs when the track or the queue length changes; warmArt
  // no-ops on already-cached/inflight urls.
  const queueLen = player.queue.length;
  useEffect(() => {
    if (!art || player.index < 0) return;
    const upcoming: (string | null)[] = [];
    for (let i = 1; i <= 5 && player.index + i < queueLen; i++) {
      upcoming.push(art.trackArt(player.queue[player.index + i], 160));
    }
    if (upcoming.length) warmArt(upcoming, 5);
  }, [art, trackId, queueLen, playerRev]);

  // Accent color pulled off the cover for the info panel wash + the
  // play/pause tint, o-music style.
  // Accent tint is extracted from the small art: it arrives over Bluetooth far
  // sooner than the hero, so the wash shows up with the first paint.
  const accent = useAccent(bgArt);

  // Lyrics need server >= 10.9; hide the toggle entirely on older servers.
  useEffect(() => {
    let stale = false;
    jf.lyricsSupported().then(ok => {
      if (!stale) setLyricsSupported(ok);
    });
    return () => {
      stale = true;
    };
  }, [jf]);

  // Fetch the current track's lyrics as soon as the track changes (one
  // request per track, cached in the client) so the toggle can dim when
  // the track has none and the lyrics tab opens instantly.
  useEffect(() => {
    if (!trackId || lyricsSupported === false) {
      setLyrics({ state: 'none' });
      return;
    }
    let stale = false;
    setLyrics({ state: 'loading' });
    jf.getLyrics(trackId, t?.durationMs ?? 0).then(
      p => {
        if (stale) return;
        if (!p || !p.lines.length) setLyrics({ state: 'none' });
        else if (p.isSynced) setLyrics({ state: 'synced', lines: p.lines });
        else setLyrics({ state: 'plain', lines: p.lines });
      },
      () => {
        if (!stale) setLyrics({ state: 'none' });
      },
    );
    return () => {
      stale = true;
    };
  }, [jf, trackId, lyricsSupported]);

  const toggleFav = (): void => {
    if (!t) return;
    const want = !t.isFavorite;
    t.isFavorite = want;
    player.touch();
    jf.toggleFavorite(t.id, want).catch(() => {
      t.isFavorite = !want;
      player.touch();
    });
  };

  if (!t) {
    return (
      <>
        <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
          <Icon name="note" size={96} className="text-white/20" />
          <div className="text-3xl font-semibold text-white/70">Nothing playing</div>
          <button
            type="button"
            onClick={() => setRemoteOpen(true)}
            className="h-18 rounded-full border border-white/20 px-8 text-2xl font-bold text-white/80 active:bg-white/10"
          >
            Play on phone
          </button>
          <button
            type="button"
            onClick={() => nav({ name: 'home' })}
            className="h-18 rounded-full bg-leaf px-8 text-2xl font-bold text-black active:brightness-90"
          >
            Browse your library
          </button>
        </div>
        {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
      </>
    );
  }

  const artPanel = showLyrics ? (
    <div className="relative h-full w-full overflow-hidden bg-[#14161c]">
      {bgArt ?? sigUrl ? (
        <img
          src={(bgArt ?? sigUrl)!}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl brightness-[0.4]"
        />
      ) : null}
      <div className="relative h-full w-full">
        <LyricsPanel lyrics={lyrics} />
      </div>
    </div>
  ) : heroArt || bgArt || sigUrl ? (
    <div className="relative h-full w-full overflow-hidden">
      <ThumbHashHero lowSrc={bgArt ?? sigUrl} highSrc={heroArt} alt={t.album || t.name} />
    </div>
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-zinc-900">
      <Icon name="note" size={96} className="text-white/15" />
    </div>
  );

  const infoPanel = (
    <InfoPanel
      isFavorite={t.isFavorite}
      onToggleFav={toggleFav}
      lyricsVisible={showLyrics}
      onToggleLyrics={() => player.setLyricsTab(!player.lyricsTab)}
      lyricsSupported={lyricsSupported}
      hasLyrics={hasLyrics}
      accent={accent}
      bgArtUrl={bgArt}
      onOpenRemote={() => setRemoteOpen(true)}
    />
  );

  if (portrait) {
    return (
      <>
        <div className="relative flex h-full flex-col" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div ref={artPanelRef} className="w-full shrink-0 overflow-hidden" style={{ height: '48%' }}>
            {artPanel}
          </div>
          <div className="min-h-0 flex-1">{infoPanel}</div>
        </div>
        {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
      </>
    );
  }

  // Inline mini UI for the morph — same structure as MiniBar, but with
  // individually controllable elements for staggered fade/scale.
  // This is NOT a separate panel; it's the same sheet's elements toggling.
  const miniMorph = t ? (
    <div className="bg-black/55 backdrop-blur-md">
      <div ref={miniSeekRef} className="flex h-5 w-full items-center px-4 opacity-0">
        <ProgressBar onSeek={() => {}} dot={false} />
      </div>
      <div className="flex items-center gap-3 px-4 py-2">
        {/* Artwork is TRUE MORPHED from the fullscreen element (morphArtRef).
            This spacer reserves the 44px slot; the morphed art lands here. */}
        <div className="h-11 w-11 shrink-0" />
        <div ref={miniTextRef} className="min-w-0 flex-1 opacity-0">
          <div className="truncate text-base font-medium text-white">{t.name}</div>
          <div className="truncate text-sm text-white/60">{t.artist}</div>
        </div>
        <div ref={miniPlayRef} className="opacity-0">
          <IconBtn size={48} label="Play" onClick={() => {}}>
            <Icon name={player.intentPlaying ? 'pause' : 'play'} size={24} />
          </IconBtn>
        </div>
        <div ref={miniNextRef} className="opacity-0">
          <IconBtn size={48} label="Next" onClick={() => {}}>
            <Icon name="next" size={24} />
          </IconBtn>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <div
        ref={sheetRef}
        className="relative h-full overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Full UI layer — fades out as we drag toward mini.
            NOTE: artwork is in its own morph layer below, not here. */}
        <div ref={fullLayerRef} className="absolute inset-0 flex">
          <div className="h-full w-[55%] shrink-0" />
          <div className="h-full min-w-0 flex-1">{infoPanel}</div>
        </div>

        {/* Artwork MORPH layer — the SAME element from fullscreen scales and
            moves to the mini position. This is a true morph, not a crossfade. */}
        <div ref={morphArtRef} className="absolute left-0 top-0 h-full w-[55%] overflow-hidden" style={{ transformOrigin: 'top left' }}>
          <div ref={artPanelRef} className="h-full w-full overflow-hidden">
            {artPanel}
          </div>
        </div>
        {/* Mini morph layer — inline mini UI with staggered elements.
            At the sheet's top; lands at screen bottom when dragged to mini.
            pointer-events-none: visual morph only. */}
        <div ref={miniLayerRef} className="pointer-events-none absolute inset-x-0 top-0">
          {miniMorph}
        </div>
        {/* Sliver layer — same ProgressBar clipped to 2px, read-only */}
        <div ref={sliverLayerRef} className="pointer-events-none absolute inset-x-0 top-0 opacity-0">
          <div className="h-[2px] w-full overflow-hidden">
            <div className="h-[3px] w-full">
              <ProgressBar onSeek={() => {}} dot={false} interactive={false} />
            </div>
          </div>
        </div>
      </div>
      {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
    </>
  );
}

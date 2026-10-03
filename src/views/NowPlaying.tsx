import { useEffect, useRef, useState, type JSX, type TouchEvent as RTouchEvent } from 'react';
import { Ghost, Icon, ProgressBar, TransportGlyph, readBlurSig, useArt, useCachedArt, usePlayer, usePortrait, warmArt } from '../components';
import { useAccent, type Accent } from '../accent';
import type { LyricLineVM } from '../jellyfin';
import { player } from '../player';
import { knob } from '../fx/knob';
import { RemoteSheet } from '../RemoteSheet';
import type { ViewProps } from '../nav';

// ThumbHash-style hero: the 160px art (already fetched for the backdrop)
// is blown up and heavily blurred as the placeholder; the 512px hero fades
// in over it when it arrives. Keyed by src so a track change replays the reveal.
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

// Shape borrowed from Ousa-Music-Player's useLyrics; none is an ordinary
// outcome, not an error.
type LyricsState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'synced'; lines: LyricLineVM[] }
  | { state: 'plain'; lines: LyricLineVM[] };

// Hold the Glass Overlay's ambient screensaver off while Now Playing is up
// (the user is watching, not touching). Sticky window flag first (the
// overlay may boot after this view mounts), then the DOM event; both are
// cleared on unmount.
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

// The last line that has started. Binary search: a synced track can carry
// hundreds of lines.
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

  // Re-evaluate a few times a second while playing; positionNow() stays
  // fresh without any snapshot traffic.
  useEffect(() => {
    if (!player.intentPlaying) return;
    const id = window.setInterval(() => force(n => n + 1), 250);
    return () => window.clearInterval(id);
  }, [player.intentPlaying]);

  const active = activeLineIndex(lines, player.positionNow());

  useEffect(() => {
    if (active !== lastActive.current && active >= 0) {
      lastActive.current = active;
      // Smooth-glide to the new line; instant jumps felt out of sync.
      lineRefs.current.get(active)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });

  return (
    <div className="h-full w-full overflow-y-auto px-6 py-8 pb-[70vh]">
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

// Lyrics for the current track are fetched once in NowPlaying (per-track
// cached in the client), so the toggle can dim when the track has none and
// the tab opens instantly.
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

// Right-hand info column, ported from o-music's Widget landscape layout.
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
  morphTitleRef,
  morphArtistRef,
  morphProgressRef,
  morphPlayRef,
  morphNextRef,
  mainRowRef,
  innerColRef,
  contentWrapRef,
  titlesRef,
  controlsRef,
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
  morphTitleRef?: React.RefObject<HTMLDivElement | null>;
  morphArtistRef?: React.RefObject<HTMLDivElement | null>;
  morphProgressRef?: React.RefObject<HTMLDivElement | null>;
  morphPlayRef?: React.RefObject<HTMLDivElement | null>;
  morphNextRef?: React.RefObject<HTMLDivElement | null>;
  mainRowRef?: React.RefObject<HTMLDivElement | null>;
  innerColRef?: React.RefObject<HTMLDivElement | null>;
  contentWrapRef?: React.RefObject<HTMLDivElement | null>;
  titlesRef?: React.RefObject<HTMLDivElement | null>;
  controlsRef?: React.RefObject<HTMLDivElement | null>;
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
      <div className="morph-fade-early absolute inset-0" aria-hidden="true">
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
      </div>
      <div ref={contentWrapRef} className="relative flex min-h-0 flex-1 flex-col px-5 py-4">
        <div ref={mainRowRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-5">
          <div ref={innerColRef} className="flex min-h-0 min-w-0 flex-1 flex-col py-1 transition-all duration-200">
            <div className="morph-fade-early flex shrink-0 items-center justify-between pt-2">
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

            {/* Fixed 202px so the seekbar below never moves. */}
            <div ref={titlesRef} className="flex h-[202px] min-w-0 shrink-0 flex-col justify-center pt-[24px] transition-all duration-200">
              <div className="min-w-0 shrink-0">
              <div
                ref={morphTitleRef}
                className={`line-clamp-3 font-display font-semibold leading-[1.2] tracking-display text-[#efefef] ${
                  small ? 'text-[1.75rem]' : 'text-[1.875rem]'
                }`}
              >
                {t.name}
              </div>
              <div ref={morphArtistRef} className="mt-1.5 line-clamp-2 text-[1.25rem] text-white/55">{t.artist}</div>
              {player.remoteActive ? (
                <div data-device-label className="mt-1 text-[1.05rem] text-leaf">Playing on {player.remoteDevice}</div>
              ) : null}
              </div>
            </div>

            <div className="morph-fade-early min-h-0 flex-1" aria-hidden="true" />
            <div className="morph-fade-early flex min-h-0 flex-[2] flex-col justify-center pt-[40px]">
              <div ref={morphProgressRef} className="morph-fade-early shrink-0">
                <ProgressBar onSeek={ms => void player.seekTo(ms)} fill={accent?.fill} />
              </div>
            </div>
          </div>

          <div ref={controlsRef} className="mb-[15px] flex w-full shrink-0 items-center justify-between transition-all duration-200">
              {lyricsSupported !== false ? (
                <div className="morph-fade-early">
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
                </div>
              ) : (
                <div className="w-6 shrink-0" aria-hidden="true" />
              )}
              <div className="morph-fade-early">
              <Ghost label="Previous" onClick={() => void player.prev()} tint={accent?.fill ?? '#a1a1aa'}>
                <TransportGlyph
                  name="skip"
                  className={small ? 'h-8 w-8 -scale-x-100' : 'h-7 w-7 -scale-x-100'}
                />
              </Ghost>
              </div>
              <div ref={morphPlayRef}>
              <Ghost
                label={player.intentPlaying ? 'Pause' : 'Play'}
                onClick={() => void player.toggle()}
                tint={accent?.fill ?? '#a1a1aa'}
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
              </div>
              <div ref={morphNextRef}>
              <Ghost label="Next" onClick={() => void player.next()} tint={accent?.fill ?? '#a1a1aa'}>
                <TransportGlyph name="skip" className={small ? 'h-8 w-8' : 'h-7 w-7'} />
              </Ghost>
              </div>
              <div className="morph-fade-early">
              <Ghost
                label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={onToggleFav}
                tint={isFavorite ? '#34d399' : undefined}
                className={isFavorite ? '' : 'opacity-40'}
              >
                <Icon name={isFavorite ? 'heartFill' : 'heart'} size={24} />
              </Ghost>
              </div>
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
  onCollapse,
  onDragProgress,
  onClose,
  miniState,
}: ViewProps & {
  onMinimize: (target?: 'mini' | 'sliver' | 'hidden') => void;
  onCollapse?: (target?: 'mini' | 'sliver' | 'hidden') => void;
  onDragProgress?: (progress: number) => void;
  onClose?: () => void;
  miniState?: 'hidden' | 'mini' | 'sliver';
}) {
  const playerRev = usePlayer();
  const art = useArt();
  const portrait = usePortrait();
  const [remoteOpen, setRemoteOpen] = useState(false);
  // On mount, snap to the App's miniState (e.g. app-start sliver).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !miniState || miniState === 'hidden') return;
    const H = el.clientHeight || window.innerHeight;
    const y = miniState === 'mini' ? H - MINI_H : H - SLIVER_H;
    el.style.transform = `translateY(${y}px)`;
    updateLayers(y);
  }, []);
  useEffect(() => {
    const unsub = player.subscribeWsPushes();
    if (player.remoteActive) player.refreshRemoteNow();
    return unsub;
  }, []);
  // Auto-prompt for a playback device when the player needs one.
  useEffect(() => {
    if (player.needsDeviceChoice) setRemoteOpen(true);
  }, [playerRev]);
  useEffect(() => {
    if (!remoteOpen && player.needsDeviceChoice) {
      // Clear the flag so it doesn't re-open on every render.
      player.needsDeviceChoice = false;
    }
  }, [remoteOpen]);
  const [lyricsSupported, setLyricsSupported] = useState<boolean | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({ state: 'loading' });
  // Sticky preference owned by the player (persisted across restarts).
  const lyricsTab = player.lyricsTab;
  const t = player.current();
  const trackId = t?.id;
  // When App changes miniState externally (e.g. track tap while in mini
  // bar sets 'hidden'), animate the sheet to match. Skips if already there
  // (avoids fighting the drag-driven updates).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || miniState === undefined) return;
    const H = el.clientHeight || window.innerHeight;
    const targetY = miniState === 'hidden' ? 0 : miniState === 'mini' ? H - MINI_H : H - SLIVER_H;
    const m = el.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    const curY = m ? parseFloat(m[1]) : 0;
    if (Math.abs(curY - targetY) > 8) {
      const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
      el.style.transition = `transform 0.35s ${ease}`;
      el.style.transform = `translateY(${targetY}px)`;
      updateLayers(targetY);
    }
  }, [miniState]);
  // On track change, re-sync the visual state and App's miniState. The DOM
  // transform survives re-renders, but effects can desync (e.g. lyrics
  // overlay reappearing, queue pill showing in mini bar).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const m = el.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    const y = m ? Math.max(0, parseFloat(m[1])) : 0;
    updateLayers(y);
    // Belt-and-suspenders: if App says we're collapsed, force-hide lyrics
    // even if the transform read was stale.
    if (miniState && miniState !== 'hidden' && lyricsOverlayRef.current) {
      lyricsOverlayRef.current.style.display = 'none';
    }
    const H = el.clientHeight || window.innerHeight;
    const miniY = H - MINI_H;
    const sliverY = H - SLIVER_H;
    if (y >= (miniY + sliverY) / 2) {
      if (onCollapse) onCollapse('sliver');
    } else if (y >= miniY * 0.5) {
      if (onCollapse) onCollapse('mini');
    } else {
      if (onCollapse) onCollapse('hidden');
    }
  }, [trackId]);
  const artPanelRef = useRef<HTMLDivElement>(null);

  // The knob drives the phone's volume on this screen: tap toggles
  // playback, long-press is a no-op (no separate volume mode to enter).
  useEffect(() => {
    knob.setMode('nowplaying');
    return () => {
      knob.setMode('scroll');
    };
  }, []);

  useEffect(() => {
    setAmbientInhibit(true);
    const onHide = (): void => setAmbientInhibit(false);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      setAmbientInhibit(false);
    };
  }, []);

  // The lyrics tab is sticky, not per-track: it stays on across track
  // changes, showing album art for tracks without lyrics.
  const hasLyrics = lyrics.state === 'synced' || lyrics.state === 'plain';
  const showLyrics = lyricsTab && hasLyrics;

  // Draggable sheet: the same panel morphs from full → mini → sliver.
  // No separate mini bar — the main panel's elements ARE the mini bar.
  const sheetRef = useRef<HTMLDivElement>(null);
  const fullLayerRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; baseY: number; dy: number; startT: number; target: EventTarget | null } | null>(null);
  const stallTimerRef = useRef<number | null>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const artBoxRef = useRef<HTMLDivElement>(null);
  const lyricsOverlayRef = useRef<HTMLDivElement>(null);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const innerColRef = useRef<HTMLDivElement>(null);
  const contentWrapRef = useRef<HTMLDivElement>(null);
  const titlesRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const miniSeekRef = useRef<HTMLDivElement>(null);
  const morphTitleRef = useRef<HTMLDivElement>(null);
  const morphArtistRef = useRef<HTMLDivElement>(null);
  const morphProgressRef = useRef<HTMLDivElement>(null);
  const morphPlayRef = useRef<HTMLDivElement>(null);
  const morphNextRef = useRef<HTMLDivElement>(null);

  const MINI_H = 84;
  const SLIVER_H = 4;

  const updateLayers = (dy: number): void => {
    // Use the sheet's own height, not window.innerHeight: when the tab bar
    // is visible (collapsed), the sheet's container is shorter.
    const H = sheetRef.current?.clientHeight || window.innerHeight;
    const miniY = H - MINI_H;
    const sliverY = H - SLIVER_H;
    const pMini = Math.min(1, Math.max(0, dy / miniY));
    const pSliver = Math.min(1, Math.max(0, (dy - miniY) / Math.max(1, sliverY - miniY)));

    // Early-fade elements: fade out via opacity, then remove from layout
    // once the fade completes (pMini >= 0.34).
    const earlyFade = 1 - Math.min(1, pMini * 3);
    if (fullLayerRef.current) {
      const fades = fullLayerRef.current.querySelectorAll('.morph-fade-early');
      fades.forEach(f => {
        const el = f as HTMLElement;
        el.style.opacity = String(earlyFade);
        if (pMini >= 0.34) el.style.display = 'none';
        else el.style.display = '';
      });
    }
    // Lyrics overlay: display:none right away on drag (no fade — fading it
    // makes the panel jump).
    if (lyricsOverlayRef.current) {
      if (pMini > 0) lyricsOverlayRef.current.style.display = 'none';
      else lyricsOverlayRef.current.style.display = '';
    }

    if (leftPanelRef.current) {
      const panelW = 440 - 380 * pMini;
      leftPanelRef.current.style.width = `${panelW}px`;
      leftPanelRef.current.style.background = pMini > 0 ? 'rgba(11, 13, 16, 0.75)' : '';
    }
    if (artBoxRef.current) {
      const artW = Math.max(60, 440 - 380 * pMini);
      const artH = Math.max(84, 480 - 396 * pMini);
      artBoxRef.current.style.width = `${artW}px`;
      artBoxRef.current.style.height = `${artH}px`;
      // At mini the art sits below the 4px seekbar (no gap).
      if (pMini >= 0.5) {
        artBoxRef.current.style.marginTop = '4px';
        artBoxRef.current.style.height = `${artH - 4}px`;
      } else {
        artBoxRef.current.style.marginTop = '';
      }
    }

    const miniMode = pMini >= 0.5;
    // Panel height interpolates 480px -> 84px with the drag, keeping the
    // morphed bar glued to the visible area (no black gap, no snap jump).
    const panelH = 480 - (480 - 84) * pMini;
    if (fullLayerRef.current) {
      fullLayerRef.current.style.height = `${panelH}px`;
    }
    if (leftPanelRef.current) {
      leftPanelRef.current.style.height = `${panelH}px`;
    }
    if (rightPanelRef.current) {
      rightPanelRef.current.style.height = `${panelH}px`;
    }
    // The content wrapper keeps its background; padding clears the seekbar.
    if (contentWrapRef.current) {
      const cw = contentWrapRef.current.style;
      // Always set (not faded): at fullscreen the blurred InfoPanel covers
      // it; as the art fades, the dark is revealed. The sheet above stays
      // transparent so Home shows through.
      cw.background = 'rgba(11, 13, 16, 0.75)';
      // Ramp the top padding in with the seekbar's opacity so they never
      // overlap mid-morph.
      cw.paddingTop = `${4 * Math.min(1, pMini * 1.5)}px`;
      if (miniMode) {
        cw.paddingBottom = '0';
      } else {
        cw.paddingBottom = '';
      }
    }
    if (innerColRef.current) {
      innerColRef.current.style.justifyContent = miniMode ? 'center' : '';
    }
    if (titlesRef.current) {
      titlesRef.current.style.height = miniMode ? 'auto' : '';
      titlesRef.current.style.paddingTop = miniMode ? '0' : '';
      titlesRef.current.style.paddingRight = miniMode ? '130px' : '';
      // Device label ("Playing on …") is not needed in the mini bar.
      const dl = titlesRef.current.querySelector('[data-device-label]') as HTMLElement | null;
      if (dl) dl.style.display = miniMode ? 'none' : '';
    }
    if (morphTitleRef.current) {
      morphTitleRef.current.style.fontSize = pMini > 0 ? `${30 - 14 * pMini}px` : '';
    }
    if (morphArtistRef.current) {
      morphArtistRef.current.style.fontSize = pMini > 0 ? `${20 - 6 * pMini}px` : '';
    }
    if (controlsRef.current) {
      const c = controlsRef.current.style;
      // No CSS transition during the morph: animating position
      // (static <-> absolute) makes the buttons jump.
      c.transition = 'none';
      // Right-align from the start of the drag so the pause button never
      // floats left first.
      if (pMini > 0.05) {
        c.position = 'absolute';
        c.right = '16px';
        c.top = '50%';
        c.transform = 'translateY(-50%)';
        c.marginBottom = '0';
        c.width = 'auto';
        c.justifyContent = 'flex-start';
        // Smooth gap 0->24px across the morph so the next button never jumps.
        c.gap = `${Math.round(24 * Math.min(1, pMini / 0.5))}px`;
      } else {
        c.position = '';
        c.right = '';
        c.top = '';
        c.transform = '';
        c.marginBottom = '';
        c.width = '';
        c.justifyContent = '';
        c.gap = '';
      }
    }

    // Mini seekbar: persists through the sliver phase; everything else fades.
    if (miniSeekRef.current) {
      miniSeekRef.current.style.opacity = String(Math.min(1, pMini * 1.5));
    }
    const fade = 1 - pSliver;
    if (leftPanelRef.current) leftPanelRef.current.style.opacity = String(fade);
    if (mainRowRef.current) mainRowRef.current.style.opacity = String(fade);
  };

  const onTouchStart = (e: RTouchEvent): void => {
    // Touches inside the lyrics panel scroll the lyrics instead of dragging.
    // Only in fullscreen; in mini/sliver the lyrics are hidden and taps
    // should open fullscreen.
    const el0 = sheetRef.current;
    let baseY0 = 0;
    if (el0) {
      const m0 = el0.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
      baseY0 = m0 ? Math.max(0, parseFloat(m0[1])) : 0;
    }
    const H0 = el0?.clientHeight || window.innerHeight;
    const isFullscreen = baseY0 < (H0 - MINI_H) * 0.5;
    if (isFullscreen && showLyrics && artPanelRef.current?.contains(e.target as Node)) return;
    const p = e.touches[0];
    const el = sheetRef.current;
    let baseY = 0;
    if (el) {
      const m = el.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
      baseY = m ? Math.max(0, parseFloat(m[1])) : 0;
      el.style.transition = 'none';
      el.style.willChange = 'transform';
    }
    dragRef.current = { startY: p.clientY, baseY, dy: 0, startT: Date.now(), target: e.target };
  };
  const onTouchMove = (e: RTouchEvent): void => {
    const d = dragRef.current;
    const el = sheetRef.current;
    if (!d || !el) return;
    const p = e.touches[0];
    const H = sheetRef.current?.clientHeight || window.innerHeight;
    const sliverY = H - SLIVER_H;
    const dy = p.clientY - d.startY;
    d.dy = dy;
    // Clamp between fullscreen (0) and sliver (sliverY); allow upward drag.
    const y = Math.min(sliverY, Math.max(0, d.baseY + dy));
    el.style.transform = `translateY(${y}px)`;
    updateLayers(y);
    onDragProgress?.(Math.min(1, Math.max(0, y) / (window.innerHeight * 0.3)));
    // Stall detector: if the finger is truly stuck (no move for 500ms),
    // snap instead of hanging. Slow drags keep resetting the timer.
    if (stallTimerRef.current) window.clearTimeout(stallTimerRef.current);
    const lastDy = dy;
    stallTimerRef.current = window.setTimeout(() => {
      if (dragRef.current && dragRef.current.dy === lastDy) onTouchEnd();
    }, 500);
  };
  const onTouchEnd = (): void => {
    const d = dragRef.current;
    const el = sheetRef.current;
    dragRef.current = null;
    if (stallTimerRef.current) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (!el) return;
    const H = sheetRef.current?.clientHeight || window.innerHeight;
    const miniY = H - MINI_H;
    const sliverY = H - SLIVER_H;
    // Recover the position from the element's transform if the drag ref was
    // lost (interrupted touch), so we always snap somewhere.
    let baseY: number;
    let dy: number;
    let dt: number;
    if (d) {
      baseY = d.baseY;
      dy = d.dy;
      dt = Date.now() - d.startT;
    } else {
      const m = el.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
      baseY = m ? Math.max(0, parseFloat(m[1])) : 0;
      dy = 0;
      dt = 9999;
    }
    const y = Math.min(sliverY, Math.max(0, baseY + dy));
    // Flick: fast gesture (|dy|>24px in <300ms) snaps in the flick direction.
    const isFlick = dt < 300 && Math.abs(dy) > 24;
    const flickDir = isFlick ? Math.sign(dy) : 0;
    let targetY: number;
    let target: 'mini' | 'sliver' | null;
    const fromFull = baseY < miniY * 0.5;
    const fromMini = !fromFull && baseY < (miniY + sliverY) / 2;
    if (fromFull) {
      if (flickDir > 0 || y >= (miniY + sliverY) / 2) {
        targetY = sliverY; target = 'sliver';
      } else if (y >= miniY * 0.4) {
        targetY = miniY; target = 'mini';
      } else {
        targetY = 0; target = null;
      }
    } else if (fromMini) {
      // Tap on the track area (not buttons) -> fullscreen.
      const t = d?.target as HTMLElement | null;
      const onInteractive = !!t?.closest?.('button, a, input');
      const isTap = Math.abs(dy) < 10 && dt < 300 && !onInteractive;
      if (isTap) {
        targetY = 0; target = null;
      } else if (flickDir > 0 || y >= (miniY + sliverY) / 2) {
        targetY = sliverY; target = 'sliver';
      } else if (flickDir < 0 || y <= miniY * 0.6) {
        targetY = 0; target = null;
      } else {
        targetY = miniY; target = 'mini';
      }
    } else {
      // From sliver: tap -> fullscreen, up (drag/flick) -> mini, else stay.
      const isTap = Math.abs(dy) < 10 && dt < 300;
      if (isTap) {
        targetY = 0; target = null;
      } else if (flickDir < 0 || y <= (miniY + sliverY) / 2) {
        targetY = miniY; target = 'mini';
      } else {
        targetY = sliverY; target = 'sliver';
      }
    }
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transition = `transform 0.35s ${ease}`;
    el.style.willChange = 'auto';
    el.style.transform = `translateY(${targetY}px)`;
    updateLayers(targetY);
    if (target) {
      // The sheet STAYS mounted at mini/sliver with its morphed elements;
      // just record miniState so the App-level bar appears if the user
      // navigates away. No handoff, no fade-in of a separate bar.
      window.setTimeout(() => {
        if (onCollapse) onCollapse(target);
        else onMinimize(target);
      }, 340);
    } else {
      onDragProgress?.(0);
      window.setTimeout(() => updateLayers(0), 350);
      window.setTimeout(() => {
        if (onCollapse) onCollapse('hidden');
        else onMinimize('hidden');
      }, 340);
    }
  };

  // Full-bleed artwork, served from the shared blob cache. Two passes, in
  // this order: the 160px art downloads FIRST and paints the blurred
  // placeholder immediately; only then does the 512px hero start. This
  // ordering is load-bearing: the art lane is strictly serial, so fetching
  // the 512 first would block the 160 behind it and the screen would stay
  // dark until the big download finished.
  const { url: bgArt, failed: bgFailed } = useCachedArt(t ? (art?.trackArt(t, 160) ?? null) : null);
  const heroSrc = t && (bgArt || bgFailed) ? (art?.trackArt(t, 512) ?? null) : null;
  const { url: heroArt } = useCachedArt(heroSrc);

  // Instant placeholder: a stored 16x16 blur signature paints with zero
  // network while the 160px downloads. Keyed by track id, falling back to
  // the album id; cleared on track change so the old track's colors never
  // linger.
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

  // Pre-warm the next few tracks' small art at back priority so
  // shuffle/skipping ahead stays instant.
  const queueLen = player.queue.length;
  useEffect(() => {
    if (!art || player.index < 0) return;
    const upcoming: (string | null)[] = [];
    for (let i = 1; i <= 5 && player.index + i < queueLen; i++) {
      upcoming.push(art.trackArt(player.queue[player.index + i], 160));
    }
    if (upcoming.length) warmArt(upcoming, 5);
  }, [art, trackId, queueLen, playerRev]);

  // Accent tint for the info panel wash + play/pause tint, extracted from
  // the small art: it arrives over Bluetooth far sooner than the hero.
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

  // Fetch the current track's lyrics on track change (one request per track,
  // cached in the client) so the toggle dims when the track has none.
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
            onClick={() => onClose ? onClose() : nav({ name: 'home' })}
            className="h-18 rounded-full bg-leaf px-8 text-2xl font-bold text-black active:brightness-90"
          >
            Browse your library
          </button>
        </div>
        {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
      </>
    );
  }

  // The left panel always holds artwork; lyrics render as an overlay on
  // top, so hiding them mid-drag swaps no content and causes no flicker.
  const artworkContent = heroArt || bgArt || sigUrl ? (
    <div className="relative h-full w-full overflow-hidden">
      <ThumbHashHero lowSrc={bgArt ?? sigUrl} highSrc={heroArt} alt={t.album || t.name} />
    </div>
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-zinc-900">
      <Icon name="note" size={96} className="text-white/15" />
    </div>
  );
  const artPanel = (
    <div className="relative h-full w-full overflow-hidden">
      {artworkContent}
      {showLyrics ? (
        <div ref={lyricsOverlayRef} className="absolute inset-0 bg-[#14161c]">
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
      ) : null}
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
      morphTitleRef={morphTitleRef}
      morphArtistRef={morphArtistRef}
      morphProgressRef={morphProgressRef}
      morphPlayRef={morphPlayRef}
      morphNextRef={morphNextRef}
      mainRowRef={mainRowRef}
      innerColRef={innerColRef}
      contentWrapRef={contentWrapRef}
      titlesRef={titlesRef}
      controlsRef={controlsRef}
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


  return (
    <>
      <div
        ref={sheetRef}
        className="pointer-events-auto relative h-full overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClick={e => {
          // Fallback tap-to-fullscreen: if the touch gesture didn't catch a
          // tap on the track area in mini/sliver, the click will.
          const t = e.target as HTMLElement;
          if (t.closest('button, a, input')) return;
          const el = sheetRef.current;
          if (!el) return;
          const m = el.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
          const y = m ? Math.max(0, parseFloat(m[1])) : 0;
          const H = el.clientHeight || window.innerHeight;
          const miniY = H - MINI_H;
          if (y >= miniY * 0.5) {
            // In mini/sliver: tap opens fullscreen.
            const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
            el.style.transition = `transform 0.35s ${ease}`;
            el.style.transform = 'translateY(0px)';
            updateLayers(0);
            window.setTimeout(() => {
              if (onCollapse) onCollapse('hidden');
              else onMinimize('hidden');
            }, 340);
          }
        }}
      >
        <div ref={fullLayerRef} className="absolute inset-0 flex">
          <div ref={leftPanelRef} className="flex h-full shrink-0 items-start justify-start overflow-hidden" style={{ width: '55%' }}>
            <div ref={artBoxRef} className="overflow-hidden" style={{ width: '100%', height: '100%' }}>
              <div ref={artPanelRef} className="h-full w-full overflow-hidden">
                {artPanel}
              </div>
            </div>
          </div>
          <div ref={rightPanelRef} className="h-full min-w-0 flex-1">{infoPanel}</div>
        </div>

        <div ref={miniSeekRef} className="pointer-events-none absolute inset-x-0 top-0 opacity-0">
          <div className="flex h-1 w-full items-center">
            <ProgressBar onSeek={() => {}} dot={false} showTimes={false} fill={accent?.fill} />
          </div>
        </div>
      </div>
      {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
    </>
  );
}

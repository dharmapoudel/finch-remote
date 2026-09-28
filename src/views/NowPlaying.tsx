import { useCallback, useEffect, useRef, useState, type TouchEvent as RTouchEvent } from 'react';
import { Ghost, Icon, ProgressBar, TransportGlyph, fmtTime, useArt, useCachedArt, usePlayer, usePortrait } from '../components';
import { useAccent, type Accent } from '../accent';
import type { LyricLineVM } from '../jellyfin';
import { player } from '../player';
import { knob } from '../fx/knob';
import { BloomArt, GlassPanel } from '../fx/shaders';
import { RemoteSheet } from '../RemoteSheet';
import type { ViewProps } from '../nav';

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
          <div className="flex min-h-0 flex-1 flex-col justify-between gap-4 py-1">
            <div className="flex shrink-0 items-center justify-between">
              <Clock />
              <button
                type="button"
                aria-label="Choose playback device"
                onClick={onOpenRemote}
                className="rounded-full border border-white/15 px-4 py-2 text-lg text-white/65 active:bg-white/10"
              >
                {player.remoteActive ? `via ${player.remoteClient}` : 'This device'}
              </button>
            </div>

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

            <div className="shrink-0">
              <ProgressBar onSeek={ms => void player.seekTo(ms)} />
            </div>
          </div>

          {/* o-music transport: bare glyphs, no circles; play/pause takes the
              cover's accent color, skips stay off-white. Lyrics and heart sit
              at the row's extremes, their icons lined up exactly with the seek
              bar's ends: the Ghost's -m-3 negative margin pulls the 24px icon
              to the row's edge (margin -12 + padding 12 = icon at x=0); no
              positive margin, which would inset it. Prev/play/next stay
              centered between them, untouched.
              Inactive icons are translucent, the active state is solid green. */}
          <div className="flex w-full shrink-0 items-center justify-between">
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
                // Old servers (< 10.9) hide the lyrics toggle entirely; keep a
                // same-size spacer (the lyrics Ghost's 24px margin box) so
                // prev/play/next stay centered.
                <div className="w-6 shrink-0" aria-hidden="true" />
              )}
              <div className={`flex items-center ${small ? 'gap-12' : 'gap-10'}`}>
              <Ghost label="Previous" onClick={() => void player.prev()}>
                <TransportGlyph
                  name="skip"
                  className={small ? 'h-9 w-9 -scale-x-100' : 'h-8 w-8 -scale-x-100'}
                />
              </Ghost>
              <Ghost
                label={player.intentPlaying ? 'Pause' : 'Play'}
                onClick={() => void player.toggle()}
                tint={accent?.fill}
                focusDefault
              >
                {player.loading ? (
                  <span className="block h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-white/85" />
                ) : (
                  <span
                    key={player.intentPlaying ? 'pause' : 'play'}
                    className="grid animate-pop place-items-center"
                  >
                    <TransportGlyph
                      name={player.intentPlaying ? 'pause' : 'play'}
                      className={small ? 'h-10 w-10' : 'h-9 w-9'}
                    />
                  </span>
                )}
              </Ghost>
              <Ghost label="Next" onClick={() => void player.next()}>
                <TransportGlyph name="skip" className={small ? 'h-9 w-9' : 'h-8 w-8'} />
              </Ghost>
              </div>
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

export default function NowPlaying({ jf, nav, onMinimize }: ViewProps & { onMinimize: () => void }) {
  usePlayer();
  const art = useArt();
  const portrait = usePortrait();
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [lyricsSupported, setLyricsSupported] = useState<boolean | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({ state: 'loading' });
  // Sticky preference owned by the player (persisted across restarts):
  // usePlayer() above re-renders us when it changes.
  const lyricsTab = player.lyricsTab;
  const t = player.current();
  const trackId = t?.id;
  const artPanelRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // ---- knob scrub mode ----
  // The knob rotates through scrub mode while this view is up: each detent
  // scrubs the position locally (HUD updates via direct DOM, no React state
  // on the hot path) and the seek only fires after 700ms of quiet, so the
  // Bluetooth link sees one seek per scrub gesture instead of one per detent.
  const pendingMs = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const hudTimeRef = useRef<HTMLSpanElement>(null);
  const hudBarRef = useRef<HTMLDivElement>(null);
  // Token so a re-show during the fx-hud-out animation cancels the hide.
  const hudToken = useRef(0);

  const hideScrubHud = useCallback((): void => {
    const hud = hudRef.current;
    if (!hud) return;
    const token = ++hudToken.current;
    hud.classList.remove('fx-hud-in');
    hud.classList.add('fx-hud-out');
    window.setTimeout(() => {
      if (hudToken.current !== token) return; // re-shown during the out animation
      hud.classList.add('hidden');
      hud.classList.remove('fx-hud-out');
    }, 160);
  }, []);

  const showScrubHud = useCallback((ms: number, dur: number): void => {
    hudToken.current++; // cancel any pending out-animation hide
    const hud = hudRef.current;
    if (!hud) return;
    hud.classList.remove('hidden', 'fx-hud-out');
    hud.classList.add('fx-hud-in');
    if (hudTimeRef.current) hudTimeRef.current.textContent = fmtTime(ms);
    if (hudBarRef.current) {
      const pct = Math.min(100, Math.max(0, (ms / dur) * 100));
      hudBarRef.current.style.width = `${pct}%`;
    }
  }, []);

  const pokeSettle = useCallback((): void => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const ms = pendingMs.current;
      pendingMs.current = null;
      if (ms != null) void player.seekTo(Math.round(ms));
      hideScrubHud();
    }, 700);
  }, [hideScrubHud]);

  useEffect(() => {
    knob.setMode('scrub');
    const off = knob.onDetent(d => {
      if (knob.mode !== 'scrub' || knob.isTyping()) return;
      const dur = player.trackDurationMs;
      if (!(dur > 0)) return;
      const v = Math.abs(d.velocity);
      const secs = v < 6 ? 5 : v < 12 ? 10 : v < 20 ? 20 : 30; // velocity-sensitive: slow=5s/detent … fast=30s/detent
      const base = pendingMs.current ?? player.positionNow();
      const next = Math.min(dur, Math.max(0, base + d.dir * secs * 1000));
      pendingMs.current = next;
      // instant local display via direct DOM (no React state on the hot path):
      showScrubHud(next, dur);
      pokeSettle();
    });
    return () => {
      off();
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
      knob.setMode('scroll');
    };
  }, [showScrubHud, pokeSettle]);

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

  // A swipe down starting near the top edge minimizes back to the mini
  // player. Touches inside the lyrics panel are left alone so the lyrics
  // keep scrolling instead of minimizing.
  const onTouchStart = (e: RTouchEvent): void => {
    const p = e.touches[0];
    touchStart.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: RTouchEvent): void => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s) return;
    const p = e.changedTouches[0];
    const dy = p.clientY - s.y;
    const dx = p.clientX - s.x;
    if (showLyrics && artPanelRef.current?.contains(e.target as Node)) return;
    if (s.y < window.innerHeight * 0.3 && dy > 70 && Math.abs(dx) < 60) {
      onMinimize();
    }
  };

  // Full-bleed artwork for the hero panel, served from the shared blob cache.
  // A small copy doubles as the blurred lyrics backdrop (cheap to blur).
  // Hero at 600px: the panel shows ~440px, so 800 was pure extra Bluetooth
  // bytes. The 200px art is already fetched for the backdrop/tint and renders
  // instantly as a progressive placeholder until the hero arrives.
  const { url: heroArt } = useCachedArt(t ? (art?.trackArt(t, 512) ?? null) : null);
  const { url: bgArt } = useCachedArt(t ? (art?.trackArt(t, 200) ?? null) : null);

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
      {bgArt ? (
        <img
          src={bgArt}
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
  ) : heroArt || bgArt ? (
    <div className="relative h-full w-full overflow-hidden">
      <BloomArt src={heroArt ?? bgArt} alt={t.album || t.name} />
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

  // Scrub HUD: glass overlay showing the scrub position while the knob
  // rotates. Driven by direct DOM writes (refs) — never React state on the
  // detent path. pointer-events-none keeps the swipe-down minimize handler
  // working underneath it.
  const scrubHud = (
    <div ref={hudRef} className="hidden pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <GlassPanel className="fx-hud-in flex items-center gap-4 rounded-3xl px-6 py-3">
        <span ref={hudTimeRef} className="font-mono text-3xl tabular-nums text-white">0:00</span>
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/15">
          <div ref={hudBarRef} className="h-full rounded-full bg-gold" style={{width:'0%'}} />
        </div>
      </GlassPanel>
    </div>
  );

  if (portrait) {
    return (
      <>
        <div className="relative flex h-full flex-col" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div ref={artPanelRef} className="w-full shrink-0 overflow-hidden" style={{ height: '48%' }}>
            {artPanel}
          </div>
          <div className="min-h-0 flex-1">{infoPanel}</div>
          {scrubHud}
        </div>
        {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
      </>
    );
  }

  return (
    <>
      <div className="relative flex h-full" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div ref={artPanelRef} className="h-full w-[55%] shrink-0 overflow-hidden">
          {artPanel}
        </div>
        <div className="h-full min-w-0 flex-1">{infoPanel}</div>
        {scrubHud}
      </div>
      {remoteOpen ? <RemoteSheet onClose={() => setRemoteOpen(false)} /> : null}
    </>
  );
}

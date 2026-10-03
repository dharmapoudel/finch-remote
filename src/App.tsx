import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bustAll, stickyBustAll } from './cache';
import { getClient } from './client';
import {
  AmbientArt,
  ArtCtx,
  Icon,
  bumpArtGen,
  clearArtCache,
  useAmbient,
  useMenu,
  usePlayer,
  type ArtResolver,
  type MenuAction,
} from './components';
import { JellyfinClient, type Creds } from './jellyfin';
import { player } from './player';
import { knob } from './fx/knob';
import { focusManager, FocusScope } from './fx/focus';
import type { View } from './nav';
import Detail from './views/Detail';
import Favorites from './views/Favorites';
import RecentTracks from './views/RecentTracks';
import Home from './views/Home';
import AlbumsHome, { AlbumListView } from './views/Albums';
import Library, { ArtistsAll, GenresAll } from './views/Library';
import PlaylistsHome, { PlaylistListView } from './views/Playlists';
import NowPlaying from './views/NowPlaying';
import { QueueHandle, QueueSheet } from './QueueSheet';
import Queue from './views/Queue';
import Setup, { CREDS_KEY, type StoredCreds } from './views/Setup';
import { type MiniState } from './MiniBar';

// Phone settings page "Clear cached data" writes this config key with a
// timestamp; the device wipes its caches when it sees it (real-time while
// running, or on the next start via the check in load()).
const CACHE_CLEAR_FLAG = 'finch:cache_clear';
const CACHE_CLEAR_HANDLED = 'finch:cache_clear_handled';

const NAV_ITEMS: { view: View; icon: 'home' | 'playlist' | 'album' | 'library'; label: string }[] = [
  { view: { name: 'home' }, icon: 'home', label: 'Home' },
  { view: { name: 'playlists' }, icon: 'playlist', label: 'Playlists' },
  { view: { name: 'albums' }, icon: 'album', label: 'Albums' },
  { view: { name: 'library' }, icon: 'library', label: 'Library' },
];

// o-music-style top tab strip: each tab's 2px line sits below its hardware
// preset button. The tab's icon is revealed only while its button is held:
// a touch press reveals it for the tap's duration; a hardware preset
// short-press switches tabs with no reveal, and only a held preset reveals
// the icon until lift. The active tab shows a leaf-green line.
const TAB_X = ['12.5%', '37.5%', '62.5%', '87.5%']; // o-music PRESET_AT, all four used
function TopTabs({
  view,
  parentName,
  onNav,
  pressedIdx,
  setPressedIdx,
}: {
  view: View;
  parentName: string | undefined;
  onNav: (v: View) => void;
  pressedIdx: number | null;
  setPressedIdx: (i: number | null) => void;
}) {
  // Detail drill-ins keep their origin tab highlighted; the favorites and
  // recent-tracks lists highlight Home.
  const activeIdx =
    view.name === 'home'
      ? 0
      : view.name === 'playlists' || view.name === 'playlistlist'
        ? 1
        : view.name === 'albums' || view.name === 'albumlist'
          ? 2
          : view.name === 'library' || view.name === 'artists' || view.name === 'genres'
            ? 3
            : view.name === 'favorites' || view.name === 'recenttracks'
              ? 0
              : view.name === 'detail'
                ? parentName === 'playlists' || parentName === 'playlistlist'
                  ? 1
                  : parentName === 'albums' || parentName === 'albumlist'
                    ? 2
                    : 3
                : 3;
  return (
    <div
      className={`relative z-10 h-[30px] shrink-0 transition-all duration-300 ${
        pressedIdx !== null ? 'h-[60px]' : ''
      }`}
    >
      {NAV_ITEMS.map((item, i) => {
        const active = i === activeIdx;
        const pressed = pressedIdx === i;
        return (
          <button
            key={item.label}
            type="button"
            aria-pressed={active}
            onClick={() => onNav(item.view)}
            onPointerDown={() => setPressedIdx(i)}
            onPointerUp={() => setPressedIdx(null)}
            onPointerCancel={() => setPressedIdx(null)}
            style={{ left: TAB_X[i] }}
            className="absolute top-0 flex w-[22%] -translate-x-1/2 flex-col items-center px-2 pb-2 outline-none focus:outline-none active:bg-white/5"
          >
            <div
              className={`h-[2px] rounded-full transition-all duration-300 ${
                active ? 'w-12 bg-leaf' : 'w-8 bg-white/20'
              }`}
            />
            <div
              className={`grid transition-all duration-300 ease-out ${
                pressed ? 'mt-1.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden">
                <div
                  className={`text-leaf transition-transform duration-300 ease-out ${
                    pressed ? 'translate-y-0' : '-translate-y-3'
                  }`}
                >
                  <Icon name={item.icon} size={24} />
                </div>
              </div>
            </div>
            <span
              className={`mt-1 text-xs tracking-[0.22em] uppercase transition-colors duration-300 ${
                active ? 'font-semibold text-white' : 'text-white/45'
              }`}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Blurred-art backdrop behind the transparent top tab strip, rendered once
// at App level OUTSIDE the animated view wrapper: the view-enter animation's
// transform traps position:fixed descendants mid-flight, flashing a black
// band behind the tabs on every tab switch.
function TabBackdrop() {
  const { src, accent } = useAmbient();
  return <AmbientArt src={src} accent={accent} fixed vibrant fullHeight />;
}

async function readCreds(): Promise<Creds | null> {
  const client = getClient();
  const get = async (key: string): Promise<string | null> => {
    try {
      const r = await client.config.get({ key });
      return r.ok ? (r.response.value ?? null) : null;
    } catch {
      return null;
    }
  };
  // Two credential sources: the phone's config and the device store. The
  // newest sign-in wins; a newer-but-empty source means "signed out" and
  // beats an older valid one.
  const server = await get('server_url');
  const apiKey = await get('api_key');
  const userId = await get('user_id');
  const configTs = Number((await get('creds_ts')) ?? 0) || 0;
  const configValid = !!(server && apiKey && userId);

  let storeCreds: StoredCreds | null = null;
  try {
    const r = await client.store.get({ key: CREDS_KEY });
    if (r.ok && r.response.value) {
      const s = JSON.parse(r.response.value) as StoredCreds;
      if (s.server && s.apiKey && s.userId) storeCreds = s;
    }
  } catch {
    // ignore
  }
  const storeTs = storeCreds?.ts ?? 0;

  if (storeTs > configTs && storeCreds) {
    return { server: storeCreds.server, apiKey: storeCreds.apiKey, userId: storeCreds.userId };
  }
  if (configValid) return { server: server!, apiKey: apiKey!, userId: userId! };
  return null;
}

export default function App() {
  const [credsState, setCredsState] = useState<'loading' | 'missing' | 'ready'>('loading');
  const [jf, setJf] = useState<JellyfinClient | null>(null);
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  // Whether the last stack change was a push rather than a root replace
  // (tab switch). The view-enter animation replays only on pushes. A ref
  // so later re-renders can't re-arm the animation after a tab switch.
  const lastNavWasPushRef = useRef(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [daemonUp, setDaemonUp] = useState(true);
  const menu = useMenu();
  // Mini player state. Set when Now Playing is dragged down; hidden while
  // fullscreen Now Playing is open.
  const [miniState, setMiniState] = useState<MiniState>('hidden');
  // Now Playing is a fullscreen overlay on top of the tabbed views, not a
  // view itself. Opening it never replaces the stack; minimizing reveals
  // the original tab underneath.
  const [npOverlayOpen, setNpOverlayOpen] = useState(false);
  const npOverlayOpenRef = useRef(false);
  npOverlayOpenRef.current = npOverlayOpen;
  const miniStateRef = useRef(miniState);
  miniStateRef.current = miniState;
  const playerRev = usePlayer();

  // The device wipes all three cache layers and reloads Home fresh. The
  // handled marker dedupes the real-time event against the startup check,
  // so a tap while the app is closed still lands once.
  const handleCacheClear = useCallback(async (flagValue: string): Promise<void> => {
    const ts = Number(flagValue) || 0;
    if (!ts) return;
    const client = getClient();
    let handled = 0;
    try {
      const r = await client.store.get({ key: CACHE_CLEAR_HANDLED });
      if (r.ok && r.response.value) handled = Number(r.response.value) || 0;
    } catch {
      // ignore: treat as never handled
    }
    if (ts <= handled) return;
    bustAll();
    stickyBustAll();
    await clearArtCache();
    bumpArtGen();
    lastNavWasPushRef.current = false;
    try {
      await client.store.put({ key: CACHE_CLEAR_HANDLED, value: String(ts) });
    } catch {
      // ignore
    }
    setStack([{ name: 'home' }]);
  }, []);

  const view = stack[stack.length - 1];
  const viewRef = useRef(view);
  viewRef.current = view;
  const stackRef = useRef(stack);
  stackRef.current = stack;

  // On app start, if a track is already playing (adopted from the phone),
  // show the micro sliver so the user knows what's playing.
  useEffect(() => {
    const t = player.current();
    if (
      t &&
      player.intentPlaying &&
      !player.external &&
      !player.error &&
      !npOverlayOpen &&
      miniState === 'hidden'
    ) {
      setNpOverlayOpen(true);
      setMiniState('sliver');
    }
  }, [npOverlayOpen, miniState, playerRev]);
  const pillRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setCredsState('loading');
    const c = await readCreds();
    if (!c) {
      setJf(null);
      player.configure(null);
      setCredsState('missing');
      return;
    }
    const client = new JellyfinClient(c);
    player.configure(client);
    await player.ensureDeviceId();
    await player.loadPrefs();
    // A "clear cached data" tap that landed while the app was closed is
    // honored here, before the first views mount and fetch.
    try {
      const flag = await getClient().config.get({ key: CACHE_CLEAR_FLAG });
      if (flag.ok && flag.response.value) await handleCacheClear(flag.response.value);
    } catch {
      // config unreadable: proceed normally
    }
    setJf(client);
    setCredsState('ready');
    // Re-attach to the remote session, adopt anything already playing, then
    // restore the last local queue so a restart doesn't lose it. Sequenced
    // so each step sees what the previous one adopted.
    try {
      await player.reconcileRemote();
      await player.reconcileOnResume();
      await player.restorePersistedQueue();
    } catch {
      // non-fatal: the player just starts empty
    }
  }, [handleCacheClear]);

  useEffect(() => {
    const client = getClient();
    const offLink = client.on(e => setDaemonUp(e.type !== 'close'));
    const offSnap = client.player.onSnapshot(reply => {
      const st = reply.state;
      player.handleSnapshot({
        context: st.context ? { uri: st.context.uri } : null,
        playback: { state: st.playback.state, positionMs: st.playback.positionMs },
      });
    });
    const offErrReply = client.player.onErrorReply(reply => {
      // playFailed carries the phone's own reason; it is the only
      // diagnostic for phone-side failures.
      const e = reply.error;
      player.handlePlayerError(e.type, e.type === 'playFailed' ? e.data.reason : undefined);
    });
    const offErrEvent = client.player.onErrorEvent(reply => {
      const e = reply.error;
      player.handlePlayerError(e.type, e.type === 'playFailed' ? e.data.reason : undefined);
    });
    // On a drop->reconnect the phone often restarts the track from the
    // beginning, so the player heals the position when the link comes back.
    const offPeer = client.peer.onSnapshot(map => {
      const connected = Object.values(map).some(p => p.companion.type === 'connected');
      player.handleGateway(connected);
    });
    const offVol = client.audio.onVolumeChanged(msg => {
      player.volume = msg.level;
      player.muted = msg.muted;
      player.touch();
    });
    const offCfg = client.config.onChanged(() => {
      void load();
    });
    client.player
      .stateGet()
      .then(res => {
        if (res.ok) {
          const st = res.response.state;
          player.handleSnapshot({
            context: st.context ? { uri: st.context.uri } : null,
            playback: { state: st.playback.state, positionMs: st.playback.positionMs },
          });
        }
      })
      .catch(() => {});
    void load();
    return () => {
      offLink();
      offSnap();
      offPeer();
      offErrReply();
      offErrEvent();
      offVol();
      offCfg();
    };
  }, [load]);

  const nav = useCallback((v: View) => {
    // Now Playing is an overlay, not a view: opening it never touches the
    // stack. The current tab stays underneath; minimizing reveals it.
    if (v.name === 'nowplaying') {
      setNpOverlayOpen(true);
      setMiniState('hidden');
      return;
    }
    const isRoot =
      v.name === 'home' ||
      v.name === 'library' ||
      v.name === 'playlists' ||
      v.name === 'albums' ||
      v.name === 'queue';
    lastNavWasPushRef.current = !isRoot;
    setStack(prev => (isRoot ? [v] : [...prev, v]));
  }, []);

  // Which top tab is currently pressed. A hardware press never sets
  // :active on the on-screen button, so the icon reveal is state-driven.
  const [pressedIdx, setPressedIdx] = useState<number | null>(null);
  const pressClearRef = useRef<number | null>(null);
  const clearPressed = useCallback(() => {
    if (pressClearRef.current !== null) {
      window.clearTimeout(pressClearRef.current);
      pressClearRef.current = null;
    }
    setPressedIdx(null);
  }, []);
  const pressTimerRef = useRef<number | null>(null);
  const cancelPressTimer = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);
  const pressTab = useCallback(
    (i: number, v: View, isRepeat: boolean) => {
      if (isRepeat) return;
      nav(v);
      cancelPressTimer();
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        setPressedIdx(i);
        // If the device never sends keyup, don't leave the icon stuck.
        if (pressClearRef.current !== null) window.clearTimeout(pressClearRef.current);
        pressClearRef.current = window.setTimeout(() => {
          pressClearRef.current = null;
          setPressedIdx(null);
        }, 1200);
      }, 500);
    },
    [nav, cancelPressTimer],
  );

  // Expand from mini bar to fullscreen with animation. The overlay stays
  // open; only the sheet state changes.
  const minimizeNowPlaying = useCallback((target: MiniState = 'mini') => {
    setNpOverlayOpen(true);
    setMiniState(target === 'hidden' ? 'hidden' : target);
  }, []);

  // Collapse the Now Playing sheet to mini/sliver WITHOUT navigating away:
  // the sheet itself stays mounted as the mini bar.
  const collapseNowPlaying = useCallback((target: MiniState = 'mini') => {
    setMiniState(target === 'hidden' ? 'hidden' : target);
  }, []);

  // Close the overlay entirely. The underlying tab is already there.
  const closeNowPlaying = useCallback(() => {
    setNpOverlayOpen(false);
    setMiniState('hidden');
  }, []);

  const back = useCallback(() => {
    lastNavWasPushRef.current = true;
    setStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const openMenu = useCallback(
    (title: string, actions: MenuAction[]) => menu.open({ title, actions }),
    [menu],
  );

  // knob volume: relative steps only; leading-edge throttle with trailing flush
  const lastNudge = useRef(0);
  const pendingDir = useRef<0 | 1 | -1>(0);
  const nudgeTimer = useRef<number | null>(null);
  const nudgeVolume = useCallback((dir: 1 | -1) => {
    const fire = (d: 1 | -1): void => {
      const c = getClient();
      if (d > 0) c.audio.volumeUp().catch(() => {});
      else c.audio.volumeDown().catch(() => {});
    };
    const now = Date.now();
    if (now - lastNudge.current >= 90) {
      lastNudge.current = now;
      fire(dir);
    } else {
      pendingDir.current = dir;
      if (nudgeTimer.current === null) {
        nudgeTimer.current = window.setTimeout(() => {
          nudgeTimer.current = null;
          const d = pendingDir.current;
          pendingDir.current = 0;
          if (d !== 0) {
            lastNudge.current = Date.now();
            fire(d);
          }
        }, 90);
      }
    }
  }, []);

  // ---- knob volume mode ----
  // A knob hold switches to volume mode (detents nudge the phone's volume);
  // a tap or 3s idle exits. On Now Playing the knob is always on volume:
  // detents nudge directly, tap toggles playback, hold is a no-op.
  const volModeRef = useRef(false);
  const volIdleRef = useRef<number | null>(null);
  const exitVolume = useCallback(() => {
    if (volIdleRef.current !== null) {
      window.clearTimeout(volIdleRef.current);
      volIdleRef.current = null;
    }
    volModeRef.current = false;
    knob.setMode(npOverlayOpenRef.current ? 'nowplaying' : 'scroll');
  }, []);
  const pokeVolume = useCallback(() => {
    if (volIdleRef.current !== null) window.clearTimeout(volIdleRef.current);
    volIdleRef.current = window.setTimeout(exitVolume, 3000);
  }, [exitVolume]);
  const enterVolume = useCallback(() => {
    knob.setMode('volume');
    volModeRef.current = true;
    pokeVolume();
  }, [pokeVolume]);

  // The knob engine owns ALL wheel events (capture, passive:false,
  // preventDefault) and Enter keydown/keyup; App routes detents/taps/holds
  // by knob mode.
  useEffect(() => {
    knob.attach();
    focusManager.attach();
    const offDetent = knob.onDetent(d => {
      if (knob.isTyping()) return;
      if (knob.mode === 'volume') {
        nudgeVolume(d.dir);
        pokeVolume();
      } else if (knob.mode === 'nowplaying') {
        nudgeVolume(d.dir);
      }
    });
    const offTap = knob.onTap(() => {
      if (knob.isTyping()) return;
      if (knob.mode === 'volume') exitVolume();
      else if (knob.mode === 'nowplaying') void player.toggle();
      else focusManager.activate();
    });
    const offHold = knob.onHold(() => {
      if (knob.isTyping()) return;
      if (knob.mode !== 'volume' && knob.mode !== 'nowplaying') enterVolume();
    });
    return () => {
      offDetent();
      offTap();
      offHold();
      focusManager.detach();
      knob.detach();
      if (volIdleRef.current !== null) {
        window.clearTimeout(volIdleRef.current);
        volIdleRef.current = null;
      }
    };
  }, [nudgeVolume, pokeVolume, enterVolume, exitVolume]);

  // View changes reset the focus list and knob mode; the Now Playing overlay
  // suspends the focus system entirely (the knob drives volume there).
  useEffect(() => {
    const np = npOverlayOpen;
    focusManager.setSuspended(np);
    if (!np) {
      focusManager.refresh();
      focusManager.reset();
    }
    if (volModeRef.current) exitVolume();
    else knob.setMode(np ? 'nowplaying' : 'scroll');
  }, [view.name, npOverlayOpen, exitVolume]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const v = viewRef.current;
      if (e.key === 'Escape') {
        // The overlay has no stack history, so Escape minimizes it.
        if (npOverlayOpenRef.current) minimizeNowPlaying();
        else back();
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        // In the overlay, M dismisses it like Escape; preventDefault
        // keeps the device from treating it as its home key.
        if (npOverlayOpenRef.current) {
          e.preventDefault();
          minimizeNowPlaying();
        } else if (v.name !== 'setup') {
          // M is the device's home key: go to Finch home, never toggle playback.
          nav({ name: 'home' });
        }
        return;
      }
      // Preset shortcuts 1-4, ignored while typing. A short press switches
      // tabs; holding past the long-press threshold reveals the tab's icon
      // (a hardware press never gives the on-screen button a CSS :active).
      if (v.name === 'setup') return;
      if (e.key === '1') pressTab(0, { name: 'home' }, e.repeat);
      else if (e.key === '2') pressTab(1, { name: 'playlists' }, e.repeat);
      else if (e.key === '3') pressTab(2, { name: 'albums' }, e.repeat);
      else if (e.key === '4') pressTab(3, { name: 'library' }, e.repeat);
    };
    window.addEventListener('keydown', onKey);
    // Lifting a hardware preset button cancels a pending long-press reveal;
    // the timeout in pressTab covers devices that never send keyup.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
        cancelPressTimer();
        clearPressed();
      }
    };
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [back, minimizeNowPlaying, nav, pressTab, clearPressed, cancelPressTimer]);

  const artResolver: ArtResolver | null = useMemo(
    () =>
      jf
        ? {
            // Tiles render at 120-140px, so 160px is crisp with far fewer
            // bytes over Bluetooth than 256. 512 is fetched on demand only
            // (drill-in headers, Now Playing hero).
            trackArt: (t, w = 160) => jf.trackImage(t, w),
            albumArt: (a, w = 160) => (a.imageTag ? jf.imageUrl(a.id, w) : null),
            artistArt: (a, w = 160) => (a.imageTag ? jf.imageUrl(a.id, w) : null),
            playlistArt: (p, w = 160) => (p.imageTag ? jf.imageUrl(p.id, w) : null),
          }
        : null,
    [jf],
  );

  const renderView = (v: View = view): React.ReactNode => {
    if (credsState === 'loading') {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/15 border-t-gold" />
        </div>
      );
    }
    if (credsState === 'missing' || !jf) {
      return <Setup jf={jf as never} nav={nav} back={back} openMenu={openMenu} onSaved={() => void load()} />;
    }
    const props = { jf, nav, back, openMenu };
    switch (v.name) {
      case 'home':
        return <Home {...props} />;
      case 'library':
        return <Library {...props} />;
      case 'artists':
        return <ArtistsAll {...props} />;
      case 'genres':
        return <GenresAll {...props} />;
      case 'playlists':
        return <PlaylistsHome {...props} />;
      case 'playlistlist':
        return <PlaylistListView {...props} kind={v.kind} />;
      case 'albums':
        return <AlbumsHome {...props} />;
      case 'albumlist':
        return <AlbumListView {...props} kind={v.kind} />;
      case 'favorites':
        return <Favorites {...props} />;
      case 'recenttracks':
        return <RecentTracks {...props} />;
      case 'detail':
        return <Detail {...props} params={v as Extract<View, { name: 'detail' }>} />;
      case 'queue':
        return <Queue {...props} />;
      case 'setup':
        return <Setup {...props} onSaved={() => void load()} />;
    }
  };

  // The tab bar is always visible when creds are ready: Now Playing is an
  // overlay on top of the tabs, never a view that replaces them.
  const showChrome = credsState === 'ready';
  const current = player.current();

  // The view-enter animation replays only on pushes, never on root
  // replaces (tab switches swap content instantly).
  const viewAnim =
    lastNavWasPushRef.current ? 'animate-view-enter' : '';

  return (
    <ArtCtx.Provider value={artResolver}>
      <div className="relative flex h-full w-full flex-col bg-zinc-950 text-white">
        {!daemonUp ? (
          <div className="flex h-12 shrink-0 items-center justify-center bg-red-900/80 text-lg">
            Lost connection to the device. Reconnect to continue.
          </div>
        ) : null}
        {showChrome ? <TabBackdrop /> : null}
        <FocusScope className="relative flex min-h-0 flex-1 flex-col">
          {showChrome ? (
            <TopTabs
              view={view}
              parentName={stack[stack.length - 2]?.name}
              onNav={nav}
              pressedIdx={pressedIdx}
              setPressedIdx={setPressedIdx}
            />
          ) : null}
          <div
            key={view.name}
            className={`relative min-h-0 w-full flex-1 ${viewAnim}`}
          >
            {renderView()}
          </div>
        </FocusScope>
        {/* Now Playing overlay: fullscreen panel on top of the tabs. When
            collapsed to mini/sliver, the underlying tab shows through. */}
        {npOverlayOpen ? (
          <div className="pointer-events-none fixed inset-0 z-40">
            <NowPlaying
              jf={jf as never}
              nav={nav}
              back={back}
              openMenu={openMenu}
              miniState={miniState}
              onMinimize={minimizeNowPlaying}
              onCollapse={collapseNowPlaying}
              onClose={closeNowPlaying}
              onDragProgress={p => {
                const pill = pillRef.current;
                if (pill) {
                  pill.style.opacity = String(1 - p);
                  // Disable pointer events once collapsed so the invisible
                  // pill doesn't intercept taps on the mini bar.
                  pill.style.pointerEvents = p > 0.5 ? 'none' : '';
                }
              }}
            />
          </div>
        ) : null}
        {/* Queue handle: fullscreen overlay only. The mini bar / sliver
            own the bottom edge everywhere else. */}
        {current && npOverlayOpen && miniState === 'hidden' ? (
          <div ref={pillRef} className="absolute bottom-0 left-1/2 z-50 -translate-x-1/2">
            <QueueHandle onOpen={() => setQueueOpen(true)} />
          </div>
        ) : null}
        {queueOpen ? (
          <QueueSheet
            onClose={() => setQueueOpen(false)}
            onOpenNowPlaying={() => {
              setQueueOpen(false);
              nav({ name: 'nowplaying' });
            }}
          />
        ) : null}
        {menu.sheet}
      </div>
    </ArtCtx.Provider>
  );
}

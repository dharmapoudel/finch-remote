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

// o-music-style top tab strip: each tab's 2px line sits directly below its
// hardware preset button, the way o-music's tick marks do. o-music hardcodes
// the preset centers as PRESET_AT = [12.5, 37.5, 62.5, 87.5] (evenly spread
// with matching margins), so these are used verbatim instead of measured.
// The label sits under its line, like o-music's COVER. The bottom nav bar is
// gone to reclaim vertical space. The tab's icon is revealed only while its
// button is held: a touch press reveals it for the tap's duration; a hardware
// preset short-press switches tabs with no reveal at all, and only a held
// (long-press) preset reveals the icon — it drops down under the line, then
// slides back up and hides when the press is lifted. The active tab is shown
// by its leaf-green line and bright label.
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
  // Detail drill-ins keep their origin tab highlighted (Library for
  // library-drilled details); the favorites and recent-tracks lists highlight Home.
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
            {/* the line, touching the very top of the screen, centered
                directly below its hardware preset button */}
            <div
              className={`h-[2px] rounded-full transition-all duration-300 ${
                active ? 'w-12 bg-leaf' : 'w-8 bg-white/20'
              }`}
            />
            {/* the icon: revealed while a touch press is held, or while a
                hardware preset is held past the long-press threshold; a
                short preset press switches tabs with no reveal. Pushes down
                above the line; slides back up and hides on lift */}
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
            {/* the label, o-music COVER style */}
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

// The single blurred-art backdrop behind the transparent top tab strip.
// Rendered once at App level, OUTSIDE the animated view wrapper: the
// view-enter animation's transform traps position:fixed descendants inside
// the view mid-flight, which flashed a black band behind the tabs on every
// tab switch. Tab views publish their art via publishAmbient().
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
  // Two sources can hold credentials: the phone's config (written by the
  // settings page) and the device store (written by on-device Quick Connect
  // / API-key setup). The newest sign-in wins; a newer-but-empty source
  // means "signed out" and beats an older valid one.
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
  // Whether the last stack change was a push (drill-in/back) rather than a
  // root replace (tab switch). The view-enter animation replays only on
  // pushes: 1.0.70 swapped tab content instantly, and the 1.1.0 "crossfade
  // with a spring" made every hardware-key tab switch visibly jump. A ref
  // (not derived per render) so later re-renders can't re-arm the animation
  // after a tab switch.
  const lastNavWasPushRef = useRef(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [daemonUp, setDaemonUp] = useState(true);
  const menu = useMenu();
  usePlayer();

  // "Clear cached data" from the phone settings page writes this config key.
  // The device wipes all three cache layers and reloads Home fresh. The
  // handled marker (device store) dedupes the real-time event against the
  // startup check below, so a tap while the app is closed still lands once.
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
  // Where Now Playing was opened from; it minimizes back here
  // (its nav replaces the stack, so back() can't).
  const returnViewRef = useRef<View>({ name: 'home' });
  // The full stack from before Now Playing replaced it; minimizing
  // restores this so back() from the return view pops to its parent
  // instead of being a no-op on a single-item stack.
  const stackBeforeNpRef = useRef<View[] | null>(null);

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
    // Re-attach to the remote session, if any; then adopt anything already
    // playing; then, if the player is still empty, restore the last local
    // queue so a restart doesn't lose it. Sequenced (not fire-and-forget)
    // so each step can see what the previous one adopted.
    try {
      await player.reconcileRemote();
      await player.reconcileOnResume();
      await player.restorePersistedQueue();
    } catch {
      // non-fatal: the player just starts empty
    }
  }, [handleCacheClear]);

  // daemon link + player/volume subscriptions, once
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
      // playFailed carries the phone's own reason (seek rejected, stream
      // died, gateway hiccup...). Surface it under the friendly message:
      // it is the only diagnostic for phone-side failures.
      const e = reply.error;
      player.handlePlayerError(e.type, e.type === 'playFailed' ? e.data.reason : undefined);
    });
    const offErrEvent = client.player.onErrorEvent(reply => {
      const e = reply.error;
      player.handlePlayerError(e.type, e.type === 'playFailed' ? e.data.reason : undefined);
    });
    // Phone Bluetooth link state: on a drop->reconnect the phone often
    // restarts the track from the beginning, so the player heals the
    // position when the link comes back.
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
    // prime from the phone's current state
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
    // bottom-nav destinations replace the stack; drill-ins push
    const cur = viewRef.current;
    // The stack is replaced (not pushed) when opening Now Playing, so
    // remember where it was opened from to minimize back to it. Any
    // non-Now-Playing view counts (album/playlist/artist detail, the full
    // favorites/recent lists, …) — a whitelist here left returnView stale
    // and M/swipe-down landed on the wrong screen.
    if (v.name === 'nowplaying' && cur.name !== 'nowplaying' && cur.name !== 'setup') {
      returnViewRef.current = cur;
      stackBeforeNpRef.current = stackRef.current;
    }
    const isRoot =
      v.name === 'home' ||
      v.name === 'library' ||
      v.name === 'playlists' ||
      v.name === 'albums' ||
      v.name === 'queue' ||
      v.name === 'nowplaying';
    lastNavWasPushRef.current = !isRoot;
    setStack(prev => (isRoot ? [v] : [...prev, v]));
  }, []);

  // which top tab is currently pressed. Drives the icon push-down reveal; a
  // hardware press never sets :active on the on-screen button, so this is
  // state-driven instead of CSS-only. (defined after nav: pressTab navigates
  // on hardware presses.)
  const [pressedIdx, setPressedIdx] = useState<number | null>(null);
  const pressClearRef = useRef<number | null>(null);
  const clearPressed = useCallback(() => {
    if (pressClearRef.current !== null) {
      window.clearTimeout(pressClearRef.current);
      pressClearRef.current = null;
    }
    setPressedIdx(null);
  }, []);
  // Long-press threshold before a HELD hardware preset button reveals its
  // tab icon. A short press just switches tabs (the bar animates as usual)
  // with no icon reveal; holding past this reveals the icon until lift.
  const pressTimerRef = useRef<number | null>(null);
  const cancelPressTimer = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);
  const pressTab = useCallback(
    (i: number, v: View, isRepeat: boolean) => {
      if (isRepeat) return; // key auto-repeat: the first keydown already handled it
      nav(v); // short press: switch tabs immediately, no icon reveal
      cancelPressTimer();
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        setPressedIdx(i); // held past the threshold: reveal the icon
        // safety: if the device never sends keyup, don't leave the icon stuck
        if (pressClearRef.current !== null) window.clearTimeout(pressClearRef.current);
        pressClearRef.current = window.setTimeout(() => {
          pressClearRef.current = null;
          setPressedIdx(null);
        }, 1200);
      }, 500);
    },
    [nav, cancelPressTimer],
  );

  const minimizeNowPlaying = useCallback(() => {
    // Now Playing replaced the stack on open, so minimizing restores the
    // whole pre-Now-Playing stack — back from the return view pops to its
    // parent instead of being stuck on a single-item stack.
    const s = stackBeforeNpRef.current;
    stackBeforeNpRef.current = null;
    lastNavWasPushRef.current = true;
    setStack(s && s.length ? s : [returnViewRef.current]);
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
  // The knob normally drives focus (scroll). A knob hold switches it to
  // volume mode: detents nudge the phone's volume (the OS shows its own
  // volume UI, so Finch renders nothing); a knob tap or 3s idle exits back
  // to the view's mode. On the Now Playing screen the knob is always on
  // volume (mode 'nowplaying'): turning it nudges volume directly, tap
  // toggles playback, and hold is a no-op.
  const volModeRef = useRef(false);
  const volIdleRef = useRef<number | null>(null);
  const exitVolume = useCallback(() => {
    if (volIdleRef.current !== null) {
      window.clearTimeout(volIdleRef.current);
      volIdleRef.current = null;
    }
    volModeRef.current = false;
    knob.setMode(viewRef.current.name === 'nowplaying' ? 'nowplaying' : 'scroll');
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

  // ---- knob/focus engine, mount once ----
  // The knob engine owns ALL wheel events (capture, passive:false,
  // preventDefault) and Enter keydown/keyup. App routes detents/taps/holds
  // by knob mode:
  // - volume: detents nudge volume (nudgeVolume is kept from before),
  //   tap exits, hold is a no-op while already in volume mode;
  // - scroll: detents are consumed by focusManager's own subscription
  //   (focusManager.attach() gates on knob.mode === 'scroll'), tap
  //   activates the settled item;
  // - nowplaying: detents nudge volume directly (no separate volume mode
  //   needed on that screen), tap toggles playback, hold is a no-op;
  // - hold outside volume/nowplaying mode enters volume mode.
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

  // View changes reset the focus list and select the knob mode for the new
  // view. Changing view exits volume mode (keep it simple). Now Playing
  // suspends the focus system entirely — the knob drives volume there, so
  // there is no focus order on that screen.
  useEffect(() => {
    const np = view.name === 'nowplaying';
    focusManager.setSuspended(np);
    if (!np) {
      focusManager.refresh();
      focusManager.reset();
    }
    if (volModeRef.current) exitVolume();
    else knob.setMode(np ? 'nowplaying' : 'scroll');
  }, [view.name, exitVolume]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const v = viewRef.current;
      if (e.key === 'Escape') {
        // Now Playing has no stack history (its nav replaced the stack),
        // so Escape minimizes it instead of popping.
        if (v.name === 'nowplaying') minimizeNowPlaying();
        else back();
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        // In Now Playing, M acts as back: dismiss the screen (like Escape)
        // instead of leaving it — the app stays open on the previous view.
        // preventDefault consumes the key so the device doesn't treat it as
        // its home key and close the app.
        if (v.name === 'nowplaying') {
          e.preventDefault();
          minimizeNowPlaying();
        } else if (v.name !== 'setup') {
          // M is the device's home key: go to Finch home, never toggle playback.
          nav({ name: 'home' });
        }
        return;
      }
      // preset shortcuts, ignored while typing in the on-screen keyboard views.
      // a short press just switches tabs (the bar animates as usual); holding
      // the button past the long-press threshold reveals the tab's icon,
      // since a hardware press never gives the on-screen button a CSS :active.
      if (v.name === 'setup') return;
      if (e.key === '1') pressTab(0, { name: 'home' }, e.repeat);
      else if (e.key === '2') pressTab(1, { name: 'playlists' }, e.repeat);
      else if (e.key === '3') pressTab(2, { name: 'albums' }, e.repeat);
      else if (e.key === '4') pressTab(3, { name: 'library' }, e.repeat);
    };
    window.addEventListener('keydown', onKey);
    // lifting a hardware preset button cancels a pending long-press reveal
    // and ends an active one; the timeout in pressTab covers devices that
    // never send keyup
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
            // Tile/squircle art downloads at squircle size: tiles render at
            // 120-140px (rows at 52-56px), so 160px is crisp with far fewer
            // bytes over the Bluetooth link than the old 256. Higher quality
            // (512) is fetched on demand only — drill-in headers and the Now
            // Playing hero pass an explicit width.
            trackArt: (t, w = 160) => jf.trackImage(t, w),
            albumArt: (a, w = 160) => (a.imageTag ? jf.imageUrl(a.id, w) : null),
            artistArt: (a, w = 160) => (a.imageTag ? jf.imageUrl(a.id, w) : null),
            playlistArt: (p, w = 160) => (p.imageTag ? jf.imageUrl(p.id, w) : null),
          }
        : null,
    [jf],
  );

  const renderView = (): React.ReactNode => {
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
    switch (view.name) {
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
        return <PlaylistListView {...props} kind={view.kind} />;
      case 'albums':
        return <AlbumsHome {...props} />;
      case 'albumlist':
        return <AlbumListView {...props} kind={view.kind} />;
      case 'favorites':
        return <Favorites {...props} />;
      case 'recenttracks':
        return <RecentTracks {...props} />;
      case 'detail':
        return <Detail {...props} params={view} />;
      case 'queue':
        return <Queue {...props} />;
      case 'nowplaying':
        return <NowPlaying {...props} onMinimize={minimizeNowPlaying} />;
      case 'setup':
        return <Setup {...props} onSaved={() => void load()} />;
    }
  };

  const showChrome = credsState === 'ready' && view.name !== 'nowplaying';
  const current = player.current();

  // The view-enter animation replays only when the last navigation was a
  // push (drill-in/back/Now Playing), never on a root replace (switching
  // between the four main tabs via hardware keys or the tab strip) — that
  // path swaps content instantly, like 1.0.70 did.
  const viewAnim =
    view.name === 'nowplaying' ? 'animate-iris' : lastNavWasPushRef.current ? 'animate-view-enter' : '';

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
            className={`min-h-0 w-full flex-1 ${viewAnim}`}
          >
            {renderView()}
          </div>
        </FocusScope>
        {/* Queue bar on every screen while a song is playing; the mini player is gone. */}
        {current ? <QueueHandle onOpen={() => setQueueOpen(true)} /> : null}
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

import { BridgethingClient, type ConnectionState } from '@bridgething/client';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createDemoApi, DEMO_SAMPLE, type Api } from './demo';
import { knob } from './fx/knob';
import { focusManager, FocusScope } from './fx/focus';
import {
  Jellyfin,
  JellyfinError,
  linkBusy,
  normalizeServerUrl,
  TICKS_PER_MS,
  type Credentials,
  type Item,
  type Session,
} from './jellyfin';
import { LOGO_URL_HI } from './logo';
import { artBusy } from './art';
import { attachKv, readBoot, writeBoot } from './persist';
import { bumpRecents } from './recents';
import { scheduleIndex, setPlaybackBusy } from './playlistIndex';
import { AmbientArt, Icon, Spinner, useAmbient, useMenu, type IconName, type MenuAction } from './ui/components';
import NowPlaying from './ui/NowPlaying';
import { CoreCtx, NowCtx, PbCtx, UiCtx, type Core, type MiniState, type Now, type Pb, type Ui, type View } from './ui/playback';
import IconAudit from './ui/IconAudit';
import { PlayOnSheet } from './ui/PlayOnSheet';
import {
  AlbumList,
  Albums,
  ArtistList,
  Detail,
  FavoriteTracks,
  GenreAlbums,
  GenreList,
  Home,
  Library,
  PlaylistList,
  Playlists,
  RecentTracks,
} from './ui/views';

// ---------------------------------------------------------------------------
// constants

const wsUrl =
  import.meta.env.VITE_BRIDGETHING_URL ??
  (typeof window !== 'undefined' ? `ws://${window.location.host}/` : 'ws://127.0.0.1:8891/');

const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo');
const DEMO_VIEW = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null;

const POLL_NOW_MS = 2000;
const POLL_BG_MS = 5000;
// 1.4.4 track-change resilience (see CHANGELOG):
/** a poll failure is shown only after this many in a row; retries back off */
const POLL_FAILS_SHOWN = 2;
const POLL_RETRY_MS = [1000, 2000, 4000];
/** how long the auto-picked player is kept while it reports no track */
const STICKY_GAP_MS = 20_000;
/** how long the last track stays on screen while the player is between tracks */
const GAP_HOLD_MS = 15_000;
/** poll this long after the playhead reaches the end of the track */
const END_POLL_MS = 1500;

function demoInitialView(): View {
  switch (DEMO_VIEW) {
    case 'playlists':
    case 'albums':
    case 'library':
    case 'favorites':
    case 'artists':
      return { name: DEMO_VIEW };
    case 'detail':
      return { name: 'detail', item: DEMO_SAMPLE.album };
    case 'playlist':
      return { name: 'detail', item: DEMO_SAMPLE.playlist };
    case 'artist':
      return { name: 'detail', item: DEMO_SAMPLE.artist };
    case 'albumlist':
      return { name: 'albumlist', kind: 'all' };
    case 'recenttracks':
    case 'genres':
      return { name: DEMO_VIEW };
    case 'genre':
      return { name: 'detail', item: DEMO_SAMPLE.genre };
    case 'recentalbums':
      return { name: 'albumlist', kind: 'played' };
    case 'recentplaylists':
      return { name: 'playlistlist', kind: 'recent' };
    case 'allplaylists':
      return { name: 'playlistlist', kind: 'all' };
    default:
      return { name: 'home' };
  }
}

function errText(err: unknown): string {
  if (err instanceof JellyfinError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

const TABS: { view: View; icon: IconName; label: string }[] = [
  { view: { name: 'home' }, icon: 'home', label: 'Home' },
  { view: { name: 'playlists' }, icon: 'playlist', label: 'Playlists' },
  { view: { name: 'albums' }, icon: 'album', label: 'Albums' },
  { view: { name: 'library' }, icon: 'library', label: 'Library' },
];
const ROOTS = new Set(['home', 'playlists', 'albums', 'library']);

// Preset-hold shortcuts (Finch 1.3.1's preset actions, kept as long presses
// now that a short press switches tabs): hold 1 = Now Playing, hold 3 = Play
// on, hold 4 = favorite the playing track.
const HOLD_MS = 800;

export default function App() {
  const client = useMemo(() => (DEMO ? null : new BridgethingClient({ url: wsUrl })), []);
  const [conn, setConn] = useState<ConnectionState>(DEMO ? 'open' : (client?.connectionState ?? 'connecting'));
  const [config, setConfig] = useState<Record<string, string> | null>(DEMO ? {} : null);
  const [fallbackDeviceId, setFallbackDeviceId] = useState<string | null>(DEMO ? 'demo' : null);

  // 1.4.0 navigation (finch-remote layout): a stack of browse views under the
  // top tabs, Now Playing as an overlay sheet (fullscreen / mini / sliver),
  // and the "Play on" sheet in place of the old Players screen.
  const [stack, setStack] = useState<View[]>(() => [demoInitialView()]);
  const [npOpen, setNpOpen] = useState(DEMO_VIEW === 'now' || DEMO_VIEW === 'lyrics' || DEMO_VIEW === 'mini' || DEMO_VIEW === 'playon');
  const [miniState, setMiniState] = useState<MiniState>(DEMO_VIEW === 'mini' ? 'mini' : 'hidden');
  const [playOnOpen, setPlayOnOpen] = useState(DEMO_VIEW === 'playon');
  const npFull = npOpen && miniState === 'hidden';
  const openNowPlaying = useCallback(() => {
    setNpOpen(true);
    setMiniState('hidden');
  }, []);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState(Date.now());
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [showLyrics, setShowLyrics] = useState(DEMO_VIEW === 'lyrics');
  const [changing, setChanging] = useState<{ at: number; fromId?: string } | null>(null);
  const [, setTick] = useState(0);

  // --- daemon connection
  useEffect(() => {
    if (!client) return;
    const off = client.on(event => {
      if (event.type === 'open' || event.type === 'close' || event.type === 'connecting') setConn(client.connectionState);
    });
    // 1.4.3 fix: the socket can open between the first render and this
    // subscription (a cached start-up paints a full screen first, and the
    // daemon socket is local and fast); without this sync that 'open' was
    // missed and Finch sat on its cached screens without ever loading.
    setConn(client.connectionState);
    return off;
  }, [client]);

  // --- config (written by the settings page in the companion app)
  useEffect(() => {
    if (!client || conn !== 'open') return;
    let live = true;
    void client.config.list().then(r => {
      if (!live) return;
      if (r.ok) setConfig(Object.fromEntries(r.response.entries.map(e => [e.key, e.value])));
      else setConfig({});
    });
    const off = client.config.onChanged(c =>
      setConfig(prev => {
        const next = { ...(prev ?? {}) };
        if (c.value === null) delete next[c.key];
        else next[c.key] = c.value;
        return next;
      }),
    );
    return () => {
      live = false;
      off();
    };
  }, [client, conn]);

  // --- 1.4.1: mirror the cached lists to the daemon's key-value store
  useEffect(() => {
    if (!client || conn !== 'open') return;
    void attachKv({
      get: async key => {
        const r = await client.store.get({ key });
        return r.ok ? r.response.value : null;
      },
      put: async (key, value) => {
        await client.store.put({ key, value });
      },
    });
  }, [client, conn]);

  // --- persistent fallback device id + preferred player
  useEffect(() => {
    if (!client || conn !== 'open') return;
    void (async () => {
      const d = await client.store.get({ key: 'device_id' });
      let id = d.ok ? d.response.value : null;
      if (!id) {
        id = `carthing-${randomId()}`;
        await client.store.put({ key: 'device_id', value: id });
      }
      setFallbackDeviceId(id);
      const ly = await client.store.get({ key: 'lyrics' });
      if (ly.ok && ly.response.value === 'on') setShowLyrics(true);
      const t = await client.store.get({ key: 'target_device' });
      if (t.ok && t.response.value) setTargetDeviceId(t.response.value);
    })();
  }, [client, conn]);

  const creds: Credentials | null = useMemo(() => {
    if (DEMO) return { serverUrl: 'demo', token: 'demo', userId: 'demo', deviceId: 'demo' };
    if (!config || !fallbackDeviceId) return null;
    const serverUrl = normalizeServerUrl(config.server_url ?? '');
    const token = (config.access_token ?? '').trim();
    const userId = (config.user_id ?? '').trim();
    if (!serverUrl || !token || !userId) return null;
    return { serverUrl, token, userId, deviceId: (config.device_id ?? '').trim() || fallbackDeviceId };
  }, [config, fallbackDeviceId]);

  // 1.4.1: which account the on-device cache belongs to. Known from the last
  // run, so the cached screens can paint before the daemon and config are up.
  const [bootUser] = useState(() => (DEMO ? 'demo' : (readBoot()?.user ?? null)));
  const credKey = creds ? (DEMO ? 'demo' : `${creds.serverUrl}|${creds.userId}`) : null;
  useEffect(() => {
    if (DEMO || config === null || fallbackDeviceId === null) return;
    writeBoot(credKey);
  }, [config, fallbackDeviceId, credKey]);
  const userKey = credKey ?? bootUser ?? '';

  const api: Api | null = useMemo(() => {
    if (DEMO) return createDemoApi();
    if (!client || !creds) return null;
    return new Jellyfin(client, creds);
  }, [client, creds]);

  const showToast = useCallback((msg: string) => setToast(t => ({ id: (t?.id ?? 0) + 1, text: msg })), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // --- poll sessions
  const pollNow = useRef<() => void>(() => {});
  useEffect(() => {
    if (!api || conn !== 'open') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const poll = async () => {
      clearTimeout(timer);
      let delay = npFull ? POLL_NOW_MS : POLL_BG_MS;
      try {
        const list = await api.sessions();
        if (!live) return;
        fails = 0;
        setSessions(list);
        setPolledAt(Date.now());
        setPollError(null);
      } catch (err) {
        // 1.4.4: one slow or failed poll is not "can't reach the server":
        // retry soon (1 s, 2 s, 4 s) and say so only after two in a row
        fails++;
        if (live && fails >= POLL_FAILS_SHOWN) setPollError(errText(err));
        delay = Math.min(delay, POLL_RETRY_MS[Math.min(fails, POLL_RETRY_MS.length) - 1]);
      } finally {
        if (live) {
          setSessionsLoaded(true);
          // 1.4.4: find the next track promptly when the song ends on its
          // own (one poll ~1.5 s after the end), and look again every 2 s
          // while the player is between tracks
          // (decided 50 ms later, once the screen has taken this poll in)
          timer = setTimeout(() => {
            if (!live) return;
            const endIn = trackEndAt.current - Date.now() + END_POLL_MS;
            if (trackEndAt.current && endIn > 250 && endIn < delay) delay = endIn;
            if (gapRef.current) delay = Math.min(delay, POLL_NOW_MS);
            (window as unknown as Record<string, unknown>).__finchNextPoll = { delay, endIn: trackEndAt.current ? endIn : null, gap: gapRef.current };
            timer = setTimeout(poll, Math.max(0, delay - 50));
          }, 50);
        }
      }
    };
    pollNow.current = () => {
      clearTimeout(timer);
      timer = setTimeout(poll, 350);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, conn, npFull]);

  // --- progress interpolation
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  // --- target player
  // 1.4.4: the player Finch picked on its own is kept through the moment
  // between two tracks (Finamp reports no track while it advances), instead
  // of jumping to another session (a paused web player, a TV) and back.
  const autoTarget = useRef<{ deviceId: string; seenAt: number } | null>(null);
  const target: Session | null = useMemo(() => {
    if (sessions.length === 0) return null;
    const pinned = targetDeviceId ? sessions.find(s => s.DeviceId === targetDeviceId) : undefined;
    if (pinned) return pinned;
    const a = autoTarget.current;
    const sticky = a ? sessions.find(s => s.DeviceId === a.deviceId) : undefined;
    if (sticky && a) {
      const playingElsewhere = sessions.some(s => s !== sticky && s.NowPlayingItem && !s.PlayState?.IsPaused);
      if (!sticky.NowPlayingItem && Date.now() - a.seenAt < STICKY_GAP_MS) return sticky;
      if (sticky.NowPlayingItem && (!sticky.PlayState?.IsPaused || !playingElsewhere)) return sticky;
    }
    const playing = sessions.find(s => s.NowPlayingItem && !s.PlayState?.IsPaused) ?? sessions.find(s => s.NowPlayingItem);
    if (playing) return playing;
    return [...sessions].sort((a, b) => (b.LastActivityDate ?? '').localeCompare(a.LastActivityDate ?? ''))[0];
  }, [sessions, targetDeviceId]);

  const chooseTarget = useCallback(
    (s: Session) => {
      setTargetDeviceId(s.DeviceId);
      void client?.store.put({ key: 'target_device', value: s.DeviceId });
    },
    [client],
  );

  // Optimistic overrides. Each one holds until a poll confirms it (or it
  // times out), so a slow player never makes the UI snap back.
  const [pauseOv, setPauseOv] = useState<{ v: boolean; at: number } | null>(null);
  const [seekOv, setSeekOv] = useState<{ ms: number; at: number } | null>(null);

  const nowItem = target?.NowPlayingItem ?? null;
  if (target && nowItem && !targetDeviceId) autoTarget.current = { deviceId: target.DeviceId, seenAt: Date.now() };
  const ps = target?.PlayState ?? {};
  const paused = pauseOv?.v ?? ps.IsPaused ?? true;
  const durationMs = (nowItem?.RunTimeTicks ?? 0) / TICKS_PER_MS;

  // Playhead clock: an anchor (position at a local time) that each poll nudges
  // toward the server's estimate instead of jumping to it, so the bar never
  // stutters, while big differences (seeks on the player, track changes) snap.
  const clock = useRef<{ pos: number; at: number; item?: string }>({ pos: 0, at: Date.now() });
  useEffect(() => {
    const now = Date.now();
    if (pauseOv && (ps.IsPaused === pauseOv.v || now - pauseOv.at > 4000)) setPauseOv(null);
    if (!target || !nowItem) {
      clock.current = { pos: 0, at: now };
      return;
    }
    const playing = !(ps.IsPaused ?? true);
    const est = (target.positionMs ?? (ps.PositionTicks ?? 0) / TICKS_PER_MS) + (playing ? now - (target.positionAt ?? now) : 0);
    if (seekOv) {
      const expect = seekOv.ms + (playing ? now - seekOv.at : 0);
      if (Math.abs(est - expect) < 2500 || now - seekOv.at > 6000) {
        setSeekOv(null);
        clock.current = { pos: Math.abs(est - expect) < 2500 ? est : expect, at: now, item: nowItem.Id };
      }
      return;
    }
    const c = clock.current;
    const shown = c.pos + (playing && !pauseOv ? now - c.at : 0);
    const diff = est - shown;
    if (c.item !== nowItem.Id || !playing || Math.abs(diff) > 1500) clock.current = { pos: est, at: now, item: nowItem.Id };
    else clock.current = { pos: shown + diff * 0.5, at: now, item: nowItem.Id };
    // 1.4.4: the end-of-track poll needs the playhead as of THIS poll (the
    // render that delivered it still used the previous clock)
    if (playing && durationMs > 0) trackEndAt.current = now + Math.max(0, durationMs - clock.current.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledAt]);

  const posNow = () => {
    const now = Date.now();
    if (seekOv) return seekOv.ms + (paused ? 0 : now - seekOv.at);
    const c = clock.current;
    return c.pos + (paused ? 0 : now - c.at);
  };
  const positionMs = Math.max(0, Math.min(durationMs || Infinity, nowItem ? posNow() : 0));
  const nowItemRef = useRef<Item | null>(null);
  nowItemRef.current = nowItem;

  // 1.4.3: the recents rows reload when the playing track changes (debounced,
  // so skipping through a queue reloads once), never on a plain poll. The
  // first track seen after launch does not count: the rows just loaded.
  const nowIdForRecents = nowItem?.Id ?? null;
  const lastNowId = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastNowId.current;
    if (nowIdForRecents) lastNowId.current = nowIdForRecents;
    if (!prev || !nowIdForRecents || prev === nowIdForRecents) return;
    // 1.4.4: not at a fixed 4 s any more: 8 s after the change, and then
    // only once the phone link is idle (no poll, cover or browse request
    // running or waiting), checked once a second, for at most 30 s more
    let t = 0;
    const started = Date.now();
    const tryBump = () => {
      if ((linkBusy() === 0 && artBusy() === 0) || Date.now() - started > 38_000) bumpRecents('tracks');
      else t = window.setTimeout(tryBump, 1000);
    };
    t = window.setTimeout(tryBump, 8000);
    return () => clearTimeout(t);
  }, [nowIdForRecents]);
  const positionMsRef = useRef(0);
  positionMsRef.current = positionMs;

  // Track changes: players briefly report no item (or the old one) while the
  // next track loads. Keep showing the last track under a loading state
  // instead of flashing "Nothing playing".
  const lastItem = useRef<{ item: Item; at: number; paused: boolean; nearEnd: boolean } | null>(null);
  if (nowItem) lastItem.current = { item: nowItem, at: Date.now(), paused, nearEnd: durationMs > 0 && positionMs >= durationMs - 4000 };
  useEffect(() => {
    if (changing && nowItem && nowItem.Id !== changing.fromId) setChanging(null);
  }, [changing, nowItem]);
  const changingLive = !!changing && Date.now() - changing.at < 9000 && (!nowItem || nowItem.Id === changing.fromId);
  // 1.4.4: held for 15 s (was 6 s), and also when the player reported the
  // old track paused at its very end before moving on (Finamp can)
  const inGap =
    !nowItem && !!lastItem.current && (!lastItem.current.paused || lastItem.current.nearEnd) && Date.now() - lastItem.current.at < GAP_HOLD_MS;
  const gapRef = useRef(false);
  gapRef.current = !nowItem && !!lastItem.current && Date.now() - lastItem.current.at < GAP_HOLD_MS;
  // when the playhead will reach the end of the track (local clock), for the end-of-track poll
  const trackEndAt = useRef(0);
  trackEndAt.current = nowItem && !paused && durationMs > 0 ? Date.now() + Math.max(0, durationMs - positionMs) : 0;
  const loadingTrack = changingLive || inGap;
  // 1.4.3: the playlist index (background, throttled) waits while Now Playing
  // is changing tracks, and starts ~75 s after a signed-in launch.
  useEffect(() => setPlaybackBusy(loadingTrack), [loadingTrack]);
  useEffect(() => (api && credKey ? scheduleIndex(api, credKey) : undefined), [api, credKey]);
  const shownItem = nowItem ?? (loadingTrack ? (lastItem.current?.item ?? null) : null);
  const [favOverride, setFavOverride] = useState<Record<string, boolean>>({});
  const isFav = nowItem ? (favOverride[nowItem.Id] ?? nowItem.UserData?.IsFavorite ?? false) : false;

  // --- commands
  const run = useCallback(
    async (fn: (a: Api, sid: string) => Promise<unknown>, needTarget = true) => {
      if (!api) return;
      if (needTarget && !target) {
        showToast('No Jellyfin player found. Open Jellyfin on your phone or TV.');
        setPlayOnOpen(true);
        return;
      }
      try {
        await fn(api, target?.Id ?? '');
      } catch (err) {
        showToast(errText(err));
      }
      pollNow.current();
    },
    [api, target, showToast],
  );

  const togglePlay = useCallback(() => {
    if (!nowItem) return;
    clock.current = { pos: positionMs, at: Date.now(), item: nowItem.Id };
    setPauseOv({ v: !paused, at: Date.now() });
    void run((a, sid) => a.command(sid, paused ? 'Unpause' : 'Pause'));
  }, [nowItem, paused, positionMs, run]);

  const markChanging = useCallback(() => setChanging({ at: Date.now(), fromId: nowItemRef.current?.Id }), []);
  const next = useCallback(() => {
    markChanging();
    void run((a, sid) => a.command(sid, 'NextTrack'));
  }, [run, markChanging]);
  const prev = useCallback(() => {
    // within the first seconds PreviousTrack changes track; later it restarts
    if (positionMsRef.current < 4000) markChanging();
    void run((a, sid) => a.command(sid, 'PreviousTrack'));
  }, [run, markChanging]);

  const seekTo = useCallback(
    (ms: number) => {
      setSeekOv({ ms, at: Date.now() });
      void run((a, sid) => a.seek(sid, ms));
    },
    [run],
  );

  const setFavorite = useCallback(
    (item: Item, on: boolean) => {
      if (!api) return;
      setFavOverride(f => ({ ...f, [item.Id]: on }));
      showToast(on ? 'Added to favorites' : 'Removed from favorites');
      void run(a => a.setFavorite(item.Id, on), false);
    },
    [api, run, showToast],
  );
  const favOf = useCallback((item: Item) => favOverride[item.Id] ?? item.UserData?.IsFavorite ?? false, [favOverride]);

  const toggleFav = useCallback(() => {
    if (!nowItem || !api) return;
    const next = !isFav;
    setFavOverride(f => ({ ...f, [nowItem.Id]: next }));
    showToast(next ? 'Added to favorites' : 'Removed from favorites');
    void run(a => a.setFavorite(nowItem.Id, next), false);
  }, [nowItem, api, isFav, run, showToast]);

  const toggleShuffle = useCallback(() => {
    const on = ps.ShuffleMode !== 'Shuffle';
    showToast(on ? 'Shuffle on' : 'Shuffle off');
    void run((a, sid) => a.setShuffle(sid, on));
  }, [ps.ShuffleMode, run, showToast]);

  const cycleRepeat = useCallback(() => {
    const order = ['RepeatNone', 'RepeatAll', 'RepeatOne'] as const;
    const cur = ps.RepeatMode ?? 'RepeatNone';
    const nxt = order[(order.indexOf(cur) + 1) % order.length];
    showToast(nxt === 'RepeatNone' ? 'Repeat off' : nxt === 'RepeatAll' ? 'Repeat all' : 'Repeat one');
    void run((a, sid) => a.setRepeat(sid, nxt));
  }, [ps.RepeatMode, run, showToast]);

  // 1.4.2: knob volume exactly as finch-remote 1.2.1 / 1.1.135 (commit
  // 97a7a027540a): relative steps to the PHONE's volume through the
  // BridgeThing companion (audio.volumeUp / volumeDown); the phone shows its
  // own OS volume overlay, Finch draws nothing. Leading-edge throttle (one
  // step per 90 ms) with a trailing flush of the last direction.
  const lastNudge = useRef(0);
  const pendingDir = useRef<0 | 1 | -1>(0);
  const nudgeTimer = useRef<number | null>(null);
  const nudgeVolume = useCallback(
    (dir: 1 | -1) => {
      const fire = (d: 1 | -1): void => {
        if (!client) return;
        if (d > 0) client.audio.volumeUp().catch(() => {});
        else client.audio.volumeDown().catch(() => {});
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
    },
    [client],
  );

  const playItems = useCallback(
    async (items: Item[], start = 0, label?: string) => {
      const ids = items.filter(i => i.Type === 'Audio').map(i => i.Id);
      if (ids.length === 0) {
        showToast('Nothing playable here');
        return;
      }
      // Jellyfin caps the URL; send a window around the start track
      const MAX = 150;
      let from = 0;
      if (ids.length > MAX) from = Math.max(0, Math.min(start, ids.length - MAX));
      const slice = ids.slice(from, from + MAX);
      markChanging();
      await run(async (a, sid) => {
        await a.playNow(sid, slice, start - from);
        showToast(label ?? `Playing on ${target?.DeviceName ?? 'player'}`);
        openNowPlaying();
      });
    },
    [run, showToast, target, markChanging, openNowPlaying],
  );

  const queueItems = useCallback(
    async (items: Item[], next = true) => {
      const ids = items.filter(i => i.Type === 'Audio').map(i => i.Id).slice(0, 150);
      if (!ids.length) return;
      await run(async (a, sid) => {
        await a.queue(sid, ids, next);
        if (next) showToast(ids.length === 1 ? 'Playing next' : `${ids.length} tracks queued next`);
        else showToast(ids.length === 1 ? 'Added to queue' : `${ids.length} tracks added to queue`);
      });
    },
    [run, showToast],
  );

  const toggleLyrics = useCallback(() => {
    setShowLyrics(v => {
      void client?.store.put({ key: 'lyrics', value: v ? 'off' : 'on' });
      return !v;
    });
  }, [client]);

  const instantMix = useCallback(
    async (item: Item) => {
      if (!api) return;
      try {
        const mix = await api.instantMix(item.Id);
        await playItems(mix, 0, `Instant mix from ${item.Name}`);
      } catch (err) {
        showToast(errText(err));
      }
    },
    [api, playItems, showToast],
  );


  // ---------------------------------------------------------------------------
  // 1.4.0 UI wiring (finch-remote interaction patterns)

  const menu = useMenu();
  const view = stack[stack.length - 1];
  const lastNavWasPush = useRef(true);

  const nav = useCallback((v: View) => {
    const isRoot = ROOTS.has(v.name);
    lastNavWasPush.current = !isRoot;
    setStack(prev => (isRoot ? [v] : [...prev, v]));
  }, []);
  const back = useCallback(() => {
    lastNavWasPush.current = true;
    setStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);
  const openMenu = useCallback((title: string, actions: MenuAction[]) => menu.open({ title, actions }), [menu]);
  const collapse = useCallback((t: MiniState) => setMiniState(t), []);
  const closeNowPlaying = useCallback(() => {
    // With a track loaded the sheet folds to the sliver; with none it closes.
    if (nowItemRef.current) setMiniState('sliver');
    else {
      setNpOpen(false);
      setMiniState('hidden');
    }
  }, []);

  // Something is playing on the target: keep the sheet mounted as the
  // sliver so the mini player is one swipe away (finch-remote's startup
  // behaviour). Nothing playing: drop a collapsed sheet.
  useEffect(() => {
    if (shownItem && !npOpen) {
      setNpOpen(true);
      setMiniState(DEMO && DEMO_VIEW === 'mini' ? 'mini' : 'sliver');
    } else if (!shownItem && npOpen && miniState !== 'hidden' && sessionsLoaded) {
      setNpOpen(false);
      setMiniState('hidden');
    }
  }, [shownItem, npOpen, miniState, sessionsLoaded]);

  // --- top tabs: short press switches, a held press reveals the icon
  const [pressedIdx, setPressedIdx] = useState<number | null>(null);
  // 1.4.4 tab strip auto-hide (Nimbus/Almanac's TabMarks behaviour): every
  // preset press bumps tabFlash (strip shows, hides 1.5 s after the press);
  // it also stays up while a preset is held (presetHeld).
  const [tabFlash, setTabFlash] = useState(0);
  const [presetHeld, setPresetHeld] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const pressClear = useRef<number | null>(null);
  const clearPress = useCallback(() => {
    for (const r of [pressTimer, holdTimer, pressClear]) {
      if (r.current !== null) window.clearTimeout(r.current);
      r.current = null;
    }
    setPressedIdx(null);
  }, []);

  // --- knob: phone volume on fullscreen Now Playing (finch-remote's
  // nudgeVolume, above), focus movement elsewhere; a knob hold in the browse
  // views enters a 3-second volume mode (finch-remote). No on-screen volume
  // UI: the phone shows its own OS volume overlay.
  const volModeRef = useRef(false);
  const volIdle = useRef<number | null>(null);
  const npFullRef = useRef(npFull);
  npFullRef.current = npFull;
  const exitVolume = useCallback(() => {
    if (volIdle.current !== null) window.clearTimeout(volIdle.current);
    volIdle.current = null;
    volModeRef.current = false;
    knob.setMode(npFullRef.current ? 'nowplaying' : 'scroll');
  }, []);
  const pokeVolume = useCallback(() => {
    if (volIdle.current !== null) window.clearTimeout(volIdle.current);
    volIdle.current = window.setTimeout(exitVolume, 3000);
  }, [exitVolume]);

  // latest closures for the long-lived input listeners
  const live = useRef({ nudgeVolume, togglePlay, toggleFav, openNowPlaying, nav, back });
  live.current = { nudgeVolume, togglePlay, toggleFav, openNowPlaying, nav, back };
  const overlays = useRef({ playOnOpen, menuOpen: menu.isOpen, npOpen, miniState, view });
  overlays.current = { playOnOpen, menuOpen: menu.isOpen, npOpen, miniState, view };
  const closeMenu = menu.close;

  useEffect(() => {
    knob.attach();
    focusManager.attach();
    const offDetent = knob.onDetent(d => {
      if (knob.isTyping()) return;
      if (knob.mode === 'volume') {
        live.current.nudgeVolume(d.dir);
        pokeVolume();
      } else if (knob.mode === 'nowplaying') live.current.nudgeVolume(d.dir);
    });
    const offTap = knob.onTap(() => {
      if (knob.mode === 'volume') exitVolume();
      else if (knob.mode === 'nowplaying') live.current.togglePlay();
      else focusManager.activate();
    });
    const offHold = knob.onHold(() => {
      if (knob.mode === 'scroll') {
        knob.setMode('volume');
        volModeRef.current = true;
        pokeVolume();
      }
    });
    return () => {
      offDetent();
      offTap();
      offHold();
      focusManager.detach();
      knob.detach();
    };
  }, [exitVolume, pokeVolume]);

  // Sheets and the fullscreen player own the knob; the browse focus list is
  // rebuilt on every view change.
  useEffect(() => {
    const npOwnsKnob = npFull && !playOnOpen && !menu.isOpen;
    focusManager.setSuspended(npOwnsKnob);
    if (!npOwnsKnob) {
      focusManager.refresh();
      focusManager.reset();
    }
    if (volModeRef.current) exitVolume();
    else knob.setMode(npOwnsKnob ? 'nowplaying' : 'scroll');
  }, [view, npFull, playOnOpen, menu.isOpen, exitVolume]);

  useEffect(() => {
    const presetOf = (e: KeyboardEvent): number | null => {
      const m = /^Digit([1-4])$/.exec(e.code);
      const k = m ? m[1] : ['1', '2', '3', '4'].includes(e.key) ? e.key : null;
      return k ? Number(k) - 1 : null;
    };
    const onKey = (e: KeyboardEvent) => {
      const o = overlays.current;
      if (e.key === 'Escape' || e.key === 'Backspace') {
        // Topmost panel first, then fullscreen -> mini -> (detail? pop : sliver).
        if (o.menuOpen) return closeMenu();
        if (o.playOnOpen) return setPlayOnOpen(false);
        const full = o.npOpen && o.miniState === 'hidden';
        if (full) {
          if (nowItemRef.current) setMiniState('mini');
          else {
            setNpOpen(false);
            setMiniState('hidden');
          }
        } else if (stackLen.current > 1) live.current.back();
        else if (o.npOpen && o.miniState === 'mini') setMiniState('sliver');
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        // M: the device's home key. Fold Now Playing, else go Home.
        e.preventDefault();
        if (o.npOpen && o.miniState === 'hidden') setMiniState('mini');
        else live.current.nav({ name: 'home' });
        return;
      }
      if (e.key === ' ' && !knob.isTyping()) {
        e.preventDefault();
        live.current.togglePlay();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        // dev keyboard stands in for the knob
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        if (knob.mode === 'scroll') focusManager.move(dir);
        else live.current.nudgeVolume(dir);
        return;
      }
      const p = presetOf(e);
      if (p === null || e.repeat) return;
      setTabFlash(n => n + 1);
      setPresetHeld(true);
      if (o.menuOpen) closeMenu();
      if (o.playOnOpen) setPlayOnOpen(false);
      if (o.npOpen && o.miniState === 'hidden' && nowItemRef.current) setMiniState('mini');
      const before = stackRef.current;
      live.current.nav(TABS[p].view);
      clearPress();
      pressTimer.current = window.setTimeout(() => {
        setPressedIdx(p);
        pressClear.current = window.setTimeout(() => setPressedIdx(null), 1600);
      }, 500);
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        // A hold is a shortcut, not a tab switch: put the screen back.
        if (p !== 0) setStack(before);
        if (p === 0) live.current.openNowPlaying();
        else if (p === 2) setPlayOnOpen(true);
        else if (p === 3) live.current.toggleFav();
      }, HOLD_MS);
    };
    const onUp = (e: KeyboardEvent) => {
      if (presetOf(e) !== null) {
        clearPress();
        setPresetHeld(false);
      }
    };
    const onBlur = () => {
      clearPress();
      setPresetHeld(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [clearPress, closeMenu]);
  const stackLen = useRef(stack.length);
  stackLen.current = stack.length;
  const stackRef = useRef(stack);
  stackRef.current = stack;

  // --- what the screens read (stable between polls except when it matters)
  const durationRef = useRef(0);
  durationRef.current = durationMs;
  const posRef = useRef(posNow);
  posRef.current = posNow;
  const loadingRef = useRef(loadingTrack);
  loadingRef.current = loadingTrack;
  const positionNow = useCallback(() => {
    if (!nowItemRef.current && !loadingRef.current) return 0;
    const d = durationRef.current || Infinity;
    return Math.max(0, Math.min(d, posRef.current()));
  }, []);

  const actImpl = {
    toggle: togglePlay,
    next,
    prev,
    seekTo,
    toggleFav,
    setFavorite,
    toggleShuffle,
    cycleRepeat,
    toggleLyrics,
    playItems,
    queueItems,
    instantMix,
    chooseTarget: (s: Session) => {
      chooseTarget(s);
      showToast(`Now controlling ${s.DeviceName}`);
    },
    openNowPlaying,
    openPlayOn: () => setPlayOnOpen(true),
    toast: showToast,
  };
  const actRef = useRef(actImpl);
  actRef.current = actImpl;
  const act = useMemo(() => {
    const out = {} as Pb['act'];
    for (const k of Object.keys(actRef.current) as (keyof Pb['act'])[]) {
      (out as Record<string, unknown>)[k] = (...args: unknown[]) =>
        (actRef.current[k] as (...a: unknown[]) => unknown)(...args);
    }
    return out;
  }, []);

  const pb: Pb = useMemo(
    () => ({
      api,
      sessions,
      sessionsLoaded,
      pollError,
      target,
      item: shownItem,
      nowId: nowItem?.Id ?? null,
      paused,
      loadingTrack,
      durationMs,
      positionNow,
      isFav,
      favOf,
      shuffle: ps.ShuffleMode === 'Shuffle',
      repeat: ps.RepeatMode ?? 'RepeatNone',
      showLyrics,
      act,
    }),
    // seekOv/polledAt: a seek or a fresh report re-renders the seek bar
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, sessions, sessionsLoaded, pollError, target, shownItem, nowItem?.Id, paused, loadingTrack, durationMs, isFav, favOf,
      ps.ShuffleMode, ps.RepeatMode, showLyrics, seekOv, polledAt],
  );
  const ui: Ui = useMemo(() => ({ nav, back, openMenu }), [nav, back, openMenu]);
  // 1.4.1: narrow contexts for the browse screens (see playback.ts).
  const core: Core = useMemo(() => ({ api, act, userKey }), [api, act, userKey]);
  const nowCtx: Now = useMemo(() => ({ nowId: nowItem?.Id ?? null, paused, favOf }), [nowItem?.Id, paused, favOf]);

  // ---------------------------------------------------------------------------
  // render

  // Cached start-up: a signed-in Finch paints its last screens (from the
  // on-device cache) straight away and refreshes once the daemon answers.
  const booting = !DEMO && !!bootUser && (conn !== 'open' || config === null || fallbackDeviceId === null);
  const configured = !!creds || booting;
  const status: 'connecting' | 'loading' | 'setup' | 'ready' =
    !DEMO && conn !== 'open' && !booting
      ? 'connecting'
      : (config === null || fallbackDeviceId === null) && !booting
        ? 'loading'
        : !configured
          ? 'setup'
          : 'ready';
  // The screen element is memoised on what it shows, so the 500 ms playhead
  // tick and session polls re-render App's state but not the screens (React
  // bails out on an identical element); the screens subscribe to the narrow
  // contexts for what they actually display.
  const body: ReactNode = useMemo(() => {
    switch (status) {
      case 'connecting':
        return <Center title="Connecting…" text="Waiting for the BridgeThing daemon on this Car Thing." spinner />;
      case 'loading':
        return <Center title="Loading…" spinner />;
      case 'setup':
        return <SetupScreen />;
    }
    switch (view.name) {
      case 'home':
        return <Home />;
      case 'playlists':
        return <Playlists />;
      case 'albums':
        return <Albums />;
      case 'library':
        return <Library />;
      case 'artists':
        return <ArtistList />;
      case 'albumlist':
        return <AlbumList kind={view.kind} />;
      case 'playlistlist':
        return <PlaylistList kind={view.kind} />;
      case 'favorites':
        return <FavoriteTracks />;
      case 'recenttracks':
        return <RecentTracks />;
      case 'genres':
        return <GenreList />;
      case 'genrealbums':
        return <GenreAlbums key={view.item.Id} item={view.item} />;
      case 'detail':
        return <Detail key={view.item.Id} item={view.item} />;
    }
  }, [status, view]);
  const closePlayOn = useCallback(() => setPlayOnOpen(false), []);
  // 1.4.4 config key tabs_autohide (boolean, default on = hidden until a
  // preset is pressed), read live from config. ?tabs=pinned / ?tabs=autohide
  // override it in ?demo renders.
  const tabsParam = DEMO ? new URLSearchParams(window.location.search).get('tabs') : null;
  const tabsAutohide = tabsParam ? tabsParam !== 'pinned' : config?.tabs_autohide !== 'false';
  const tabsPinned = !tabsAutohide && ROOTS.has(view.name);
  const viewSub =
    view.name === 'detail' || view.name === 'genrealbums' ? view.item.Id : view.name === 'albumlist' || view.name === 'playlistlist' ? view.kind : '';
  const viewKey = `${stack.length}:${view.name}:${viewSub}:${configured ? 1 : 0}`;

  if (DEMO && DEMO_VIEW === 'icons') {
    return (
      <div className="h-[480px] w-[800px]">
        <IconAudit />
      </div>
    );
  }

  return (
    <PbCtx.Provider value={pb}>
      <CoreCtx.Provider value={core}>
      <NowCtx.Provider value={nowCtx}>
      <UiCtx.Provider value={ui}>
        {/* overflow: clip (1.4.2) makes the root and the Now Playing layer
            non-scrollable even by script, so nothing can push the screen
            (and the folded sheet) off its place; overflow-hidden stays as
            the fallback on engines without clip. */}
        <div className="relative flex h-[480px] w-[800px] flex-col overflow-hidden bg-zinc-950 text-white" style={{ overflow: 'clip' }}>
          {!DEMO && conn === 'closed' ? (
            <div className="flex h-12 shrink-0 items-center justify-center bg-red-900/80 text-lg">
              Lost connection to the device. Reconnect to continue.
            </div>
          ) : null}
          {configured ? <TabBackdrop /> : null}
          <FocusScope className="relative flex min-h-0 flex-1 flex-col">
            {/* 1.4.4: the strip overlays the screen (absolute, no background
                at all); only a pinned strip on a tab root reserves its 30 px,
                so the views never move when it shows or hides. See-all and
                detail screens have no strip (compact header instead). */}
            {configured && tabsPinned ? <div className="h-[30px] shrink-0" aria-hidden="true" /> : null}
            <div key={viewKey} className={`relative min-h-0 w-full flex-1 ${lastNavWasPush.current ? 'animate-view-enter' : ''}`}>
              {body}
            </div>
            {configured ? (
              <TopTabs
                view={view}
                parent={stack[stack.length - 2]}
                pressedIdx={pressedIdx}
                setPressedIdx={setPressedIdx}
                onNav={nav}
                pinned={tabsPinned}
                flashKey={tabFlash}
                held={presetHeld}
              />
            ) : null}
          </FocusScope>

          {configured && npOpen ? (
            <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" style={{ overflow: 'clip' }}>
              <NowPlaying miniState={miniState} onCollapse={collapse} onClose={closeNowPlaying} />
            </div>
          ) : null}

          {playOnOpen ? <PlayOnSheet onClose={closePlayOn} /> : null}
          {menu.sheet}

          {toast ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 z-[70] flex justify-center">
              <div
                key={toast.id}
                className="max-w-[640px] animate-pop truncate rounded-full bg-white/95 px-6 py-3 text-lg font-semibold text-zinc-950 shadow-2xl"
              >
                {toast.text}
              </div>
            </div>
          ) : null}
        </div>
      </UiCtx.Provider>
      </NowCtx.Provider>
      </CoreCtx.Provider>
    </PbCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// chrome

// Blurred-art backdrop behind the transparent tab strip, rendered once at App
// level, outside the animated view wrapper.
const TabBackdrop = memo(function TabBackdrop() {
  const { url, accent } = useAmbient();
  return <AmbientArt url={url} accent={accent} vibrant fullHeight />;
});

// finch-remote's top tab strip: each tab's 2px line sits under its preset
// button; the icon is revealed only while the button is held.
const TAB_X = ['12.5%', '37.5%', '62.5%', '87.5%'];
const TopTabs = memo(function TopTabs({
  view,
  parent,
  pressedIdx,
  setPressedIdx,
  onNav,
  pinned,
  flashKey,
  held,
}: {
  view: View;
  parent: View | undefined;
  pressedIdx: number | null;
  setPressedIdx: (i: number | null) => void;
  onNav: (v: View) => void;
  pinned: boolean;
  flashKey: number;
  held: boolean;
}) {
  // 1.4.4: Nimbus/Almanac TabMarks timing, copied exactly: a preset press
  // shows the strip and it hides 1.5 s after that press (each press restarts
  // it); a held preset keeps it up. Show = 450 ms spring
  // cubic-bezier(0.34,1.36,0.64,1) from translateY(-10px) + opacity 0; hide
  // = 700 ms cubic-bezier(0.4,0,0.2,1). Opacity/transform only.
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (flashKey === 0) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1500);
    return () => window.clearTimeout(t);
  }, [flashKey]);
  const show = pinned || flash || held;
  const tabOf = (v: View | undefined): number => {
    if (!v) return 0;
    switch (v.name) {
      case 'home':
      case 'favorites':
      case 'recenttracks':
        return 0;
      case 'playlists':
      case 'playlistlist':
        return 1;
      case 'albums':
      case 'albumlist':
        return 2;
      case 'library':
      case 'artists':
      case 'genres':
        return 3;
      case 'detail':
      case 'genrealbums':
        return -1;
    }
  };
  let activeIdx = tabOf(view);
  if (activeIdx === -1) activeIdx = Math.max(0, tabOf(parent));
  return (
    <div
      className="tabstrip absolute inset-x-0 top-0 z-30 h-[60px]"
      data-shown={show ? 'true' : 'false'}
      style={{
        pointerEvents: 'none',
        opacity: show ? 1 : 0,
        transform: show ? 'none' : 'translateY(-10px)',
        transitionProperty: 'opacity, transform',
        transitionTimingFunction: show ? 'cubic-bezier(0.34,1.36,0.64,1)' : 'cubic-bezier(0.4,0,0.2,1)',
        transitionDuration: show ? '450ms' : '700ms',
      }}
    >
      {TABS.map((t, i) => {
        const active = i === activeIdx;
        const pressed = pressedIdx === i;
        return (
          <button
            key={t.label}
            type="button"
            aria-pressed={active}
            aria-hidden={show ? undefined : true}
            tabIndex={show ? undefined : -1}
            onClick={() => onNav(t.view)}
            onPointerDown={() => setPressedIdx(i)}
            onPointerUp={() => setPressedIdx(null)}
            onPointerCancel={() => setPressedIdx(null)}
            onPointerLeave={() => pressed && setPressedIdx(null)}
            style={{ left: TAB_X[i], pointerEvents: show ? 'auto' : 'none' }}
            className="absolute top-0 flex w-[22%] -translate-x-1/2 flex-col items-center bg-transparent px-2 pb-2 outline-none focus:outline-none"
          >
            <div
              className={`h-[2px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-all duration-300 ${active ? 'w-12 bg-leaf' : 'w-8 bg-white/30'}`}
            />
            <div className={`grid transition-all duration-300 ease-out ${pressed ? 'mt-1.5 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div
                  className={`text-leaf drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-transform duration-300 ease-out ${pressed ? 'translate-y-0' : '-translate-y-3'}`}
                >
                  <Icon name={t.icon} size={24} />
                </div>
              </div>
            </div>
            <span
              className={`tab-label mt-1 text-xs tracking-[0.22em] uppercase transition-colors duration-300 ${
                active ? 'font-semibold text-white' : 'text-white/60'
              }`}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
});

function Center({ title, text, spinner }: { title: string; text?: string; spinner?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-12 text-center">
      {spinner ? <Spinner label="" /> : null}
      <h1 className="font-display text-3xl font-semibold">{title}</h1>
      {text ? <p className="max-w-[520px] text-xl text-white/50">{text}</p> : null}
    </div>
  );
}

function SetupScreen() {
  return (
    <div className="flex h-full items-center gap-12 px-16">
      <img src={LOGO_URL_HI} alt="Finch" className="h-40 w-40 shrink-0 rounded-[36px] shadow-2xl shadow-black/60" draggable={false} />
      <div>
        <h1 className="font-display text-5xl font-semibold tracking-display">Finch</h1>
        <p className="mt-1 mb-6 text-xl text-white/55">Your Jellyfin music, on the Car Thing.</p>
        <ol className="space-y-3 text-xl">
          {['Open the BridgeThing app on your phone', 'Tap Finch, then Settings', 'Enter your server and sign in'].map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-leaf/15 font-semibold text-leaf">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-base text-white/35">The phone must be able to reach your Jellyfin server.</p>
      </div>
    </div>
  );
}

// Finch 1.4.3: which playlists contain which tracks, so playlists played from
// ANY player (Finamp included) can be found in the play history.
//
// Jellyfin has no "playlists containing this item" route, so Finch reads each
// playlist's track ids once and keeps a compact index on the device:
//   - one 7-char hash per track id (FNV-1a, base36), concatenated per
//     playlist: about 7 bytes per playlist entry, so 50 x 200 tracks is ~70 KB;
//   - stored in the persistent list cache (persist.ts), pinned and local-only
//     (rebuildable, so it does not crowd the client.store mirror);
//   - each playlist's signature (ChildCount + DateLastSaved) says when its ids
//     must be read again. A full signature check (one request) runs at most
//     every 6 h; the Playlists tab's own list also flags changed playlists.
// Building is throttled to spare the phone link (see "building" below).
//
// Deduction (deducePlaylists): the recent plays, newest first, are split into
// listening sessions (a gap over 30 min starts a new one). A playlist counts
// as played in a session when two of its tracks were played within two
// places of each other in the history, no more than 20 min apart, and from
// different albums (an album played in order never counts, nor does a lone
// track that happens to be in a playlist). When several playlists match the
// same session, only those with at least 60% of the best match count stay.
// Its played time is the newest matching play.
import { artBusy } from './art';
import type { Api } from './demo';
import { foregroundInFlight, type Item } from './jellyfin';
import { getList, putList } from './persist';
import { bumpRecents } from './recents';

const TTL_MS = 6 * 3600 * 1000;
const H = 7; // chars per hashed id

type Stored = { v: 1; at: number; sig: Record<string, string>; h: Record<string, string> };

export function hashId(raw: string): string {
  // ids arrive as 32 hex chars (items) or dashed GUIDs (PlaylistDto.ItemIds)
  const id = raw.replace(/-/g, '').toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(H, '0');
}

export const sigOf = (p: Item): string => `${p.ChildCount ?? ''}|${p.DateLastSaved ?? ''}`;

const keyOf = (userKey: string) => `${userKey}:local:playlist-index`;
const emptyIndex = (): Stored => ({ v: 1, at: 0, sig: {}, h: {} });

let mem: { userKey: string; stored: Stored; map: Map<string, string[]> } | null = null;

function storedOrNull(userKey: string): Stored | null {
  if (mem?.userKey === userKey) return mem.stored;
  const s = getList<Stored>(keyOf(userKey));
  return s && s.v === 1 ? s : null;
}
function stored(userKey: string): Stored {
  return storedOrNull(userKey) ?? emptyIndex();
}

function buildMap(st: Stored): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [pl, str] of Object.entries(st.h)) {
    for (let i = 0; i + H <= str.length; i += H) {
      const k = str.slice(i, i + H);
      const cur = map.get(k);
      if (!cur) map.set(k, [pl]);
      else if (cur[cur.length - 1] !== pl) cur.push(pl);
    }
  }
  return map;
}

/** hash -> playlist ids, built from the stored strings on first use. */
function lookup(userKey: string): Map<string, string[]> {
  if (mem?.userKey !== userKey) {
    const st = storedOrNull(userKey);
    // nothing on disk (yet: the cache may still be loading): do not memoise
    if (!st) return new Map();
    mem = { userKey, stored: st, map: buildMap(st) };
  }
  return mem.map;
}

function save(userKey: string, st: Stored): void {
  // memory keeps the new index even if it is too big for the disk record
  putList(keyOf(userKey), st, 'local');
  mem = { userKey, stored: st, map: buildMap(st) };
}

// ---- building (throttled, background) ----
//
// The phone link (Bluetooth) carries everything, so the index never competes
// with the user:
//   - nothing before START_MS (75 s) after launch;
//   - before every request it waits until the link and the user are quiet:
//     no foreground Jellyfin request in flight (browsing, polls, commands),
//     no art loading, Now Playing not changing tracks, and no touch / knob /
//     key input for QUIET_MS;
//   - one request at a time, GAP_MS between requests. Ids come from the
//     ids-only PlaylistDto (Jellyfin 10.9+, one ~8 KB request per 200-track
//     playlist); older servers fall back to PAGE-sized pages of item records;
//   - progress is saved after every playlist, so a restart resumes where it
//     stopped (finished playlists keep their signature and are skipped);
//   - later runs read only playlists whose ChildCount / DateLastSaved changed.
// Timing can be overridden for headless QA via window.__finchPlIndexTiming.
const T = {
  startMs: 75_000,
  gapMs: 1_750,
  quietMs: 10_000,
  page: 100,
  ...((typeof window !== 'undefined' && (window as unknown as { __finchPlIndexTiming?: object }).__finchPlIndexTiming) || {}),
};

const stats = { requests: 0, bytes: 0, ms: 0, waitedMs: 0, playlists: 0, startedAt: 0, finishedAt: 0 };
let armed = false;
let running = false;
let target: { api: Api; userKey: string } | null = null;
let wantFull = false;
const wantSome = new Map<string, Item>();

let lastInput = 0;
/** Does the server have the ids-only PlaylistDto route? null = not known yet. */
let idsRoute: boolean | null = null;
let playbackBusy = false;
if (typeof window !== 'undefined') {
  const mark = () => (lastInput = Date.now());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, mark, { capture: true, passive: true });
}
/** App: Now Playing is switching tracks / a playback command is pending. */
export function setPlaybackBusy(busy: boolean): void {
  playbackBusy = busy;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitQuiet(): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const quiet = Date.now() - lastInput >= T.quietMs;
    if (quiet && !playbackBusy && foregroundInFlight() === 0 && artBusy() === 0) break;
    await sleep(500);
  }
  stats.waitedMs += Date.now() - t0;
}

/** App, once per signed-in launch: arm the index START_MS from now. */
export function scheduleIndex(api: Api, userKey: string): () => void {
  if (!userKey) return () => {};
  target = { api, userKey };
  if (Date.now() - stored(userKey).at > TTL_MS) wantFull = true;
  const timer = setTimeout(() => {
    armed = true;
    kick();
  }, T.startMs);
  return () => clearTimeout(timer);
}

/** The Playlists tab saw these playlists: re-read only the ones that changed. */
export function notePlaylists(api: Api, userKey: string, items: Item[]): void {
  if (!userKey) return;
  target = { api, userKey };
  const st = stored(userKey);
  for (const p of items) if (st.sig[p.Id] !== sigOf(p) || st.h[p.Id] === undefined) wantSome.set(p.Id, p);
  if (Date.now() - st.at > TTL_MS) wantFull = true;
  kick();
}

function kick(): void {
  if (!armed || running || !target || (!wantFull && !wantSome.size)) return;
  void build(target.api, target.userKey);
}

async function build(api: Api, userKey: string): Promise<void> {
  running = true;
  if (!stats.startedAt) stats.startedAt = Date.now();
  const t0 = performance.now();
  let changed = false;
  try {
    const st: Stored = { ...stored(userKey), sig: { ...stored(userKey).sig }, h: { ...stored(userKey).h } };
    let list: Item[];
    const full = wantFull;
    if (full) {
      await waitQuiet();
      const r = await api.playlistSigs();
      stats.requests++;
      stats.bytes += r.bytes;
      list = r.items;
      const live = new Set(list.map(p => p.Id));
      for (const id of Object.keys(st.h)) {
        if (!live.has(id)) {
          delete st.h[id];
          delete st.sig[id];
          changed = true;
        }
      }
    } else list = [...wantSome.values()];
    wantSome.clear();
    for (const p of list) {
      if (st.sig[p.Id] === sigOf(p) && st.h[p.Id] !== undefined) continue;
      let ids: string[] = [];
      let fast: { ids: string[]; bytes: number } | null = null;
      if (idsRoute !== false) {
        await sleep(T.gapMs);
        await waitQuiet();
        fast = await api.playlistIdsOnly(p.Id);
        stats.requests++;
        stats.bytes += fast?.bytes ?? 0;
        if (idsRoute === null) idsRoute = !!fast;
      }
      if (fast) ids = fast.ids;
      else {
        // older server: small pages of item records
        for (let start = 0; ; start += T.page) {
          await sleep(T.gapMs);
          await waitQuiet();
          const r = await api.playlistItemIds(p.Id, start, T.page);
          stats.requests++;
          stats.bytes += r.bytes;
          ids.push(...r.ids);
          if (!r.ids.length || start + r.ids.length >= r.total) break;
        }
      }
      st.h[p.Id] = ids.map(hashId).join('');
      st.sig[p.Id] = sigOf(p);
      stats.playlists++;
      changed = true;
      save(userKey, st); // resume point
    }
    if (full) {
      st.at = Date.now();
      wantFull = false;
    }
    save(userKey, st);
    stats.finishedAt = Date.now();
  } catch {
    /* offline or server error: the next trigger resumes from the saved progress */
  } finally {
    stats.ms += Math.round(performance.now() - t0);
    running = false;
    if (changed) bumpRecents('playlists');
    if (wantSome.size) setTimeout(kick, T.gapMs);
  }
}

// ---- deduction ----

export type Play = { Id: string; AlbumId?: string; t: number };

const SESSION_GAP_MS = 30 * 60_000;
const PAIR_GAP_MS = 20 * 60_000;
const PAIR_SPAN = 2;

/** Playlists played according to the play history (newest first in, newest first out). */
export function deducePlaylists(userKey: string, plays: Play[]): { id: string; t: number }[] {
  if (!userKey || !plays.length) return [];
  const map = lookup(userKey);
  if (!map.size) return [];
  const best = new Map<string, number>();
  let start = 0;
  for (let i = 1; i <= plays.length; i++) {
    if (i < plays.length && plays[i - 1].t - plays[i].t <= SESSION_GAP_MS) continue;
    const session = plays.slice(start, i);
    start = i;
    // matched positions per playlist within the session
    const hits = new Map<string, number[]>();
    session.forEach((p, k) => {
      for (const pl of map.get(hashId(p.Id)) ?? []) {
        const arr = hits.get(pl);
        if (arr) arr.push(k);
        else hits.set(pl, [k]);
      }
    });
    const passing: { pl: string; n: number; t: number }[] = [];
    for (const [pl, ks] of hits) {
      if (ks.length < 2) continue;
      let ok = false;
      for (let a = 0; a < ks.length && !ok; a++) {
        for (let b = a + 1; b < ks.length && ks[b] - ks[a] <= PAIR_SPAN; b++) {
          const x = session[ks[a]];
          const y = session[ks[b]];
          if (Math.abs(x.t - y.t) <= PAIR_GAP_MS && (!x.AlbumId || !y.AlbumId || x.AlbumId !== y.AlbumId)) {
            ok = true;
            break;
          }
        }
      }
      if (ok) passing.push({ pl, n: ks.length, t: session[ks[0]].t });
    }
    const top = Math.max(0, ...passing.map(p => p.n));
    for (const p of passing) if (p.n >= top * 0.6 && (best.get(p.pl) ?? 0) < p.t) best.set(p.pl, p.t);
  }
  return [...best.entries()].map(([id, t]) => ({ id, t })).sort((a, b) => b.t - a.t);
}

/** QA diagnostics: last build cost and index size (no user data). */
export function indexStats(userKey: string) {
  const st = stored(userKey);
  const map = lookup(userKey);
  return {
    ...stats,
    running,
    armed,
    builtAt: st.at,
    indexedPlaylists: Object.keys(st.h).length,
    entries: Object.values(st.h).reduce((n, s) => n + s.length / H, 0),
    distinctTracks: map.size,
    storedChars: JSON.stringify(st).length,
  };
}
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__finchPlIndex = indexStats;

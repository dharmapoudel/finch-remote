// shared ui: icons, artwork, tiles, rows, keyboard, progress, menus.
// every interactive target is at least 64px; no vw/vh or fixed positioning
// for layout, the daemon pins the viewport at 800x480 and rotates the page.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { player } from './player';
import { getClient } from './client';
import { gatedNet } from './netgate';
import type { Album, Artist, Playlist, Track } from './jellyfin';
import { FocusScope } from './fx/focus';
import { GlassPanel } from './fx/shaders';

// ---- artwork cache ----
// Three tiers. (1) In-memory blob URLs (LRU 120): repeat renders within a
// session never re-hit the network. (2) Persistent daemon-store cache
// (LRU 48, base64 JPEG): a cold start paints art it already saw without
// downloading a byte. (3) Network — every fetch draws from the shared
// netgate pool (3 slots total across JSON, art, and commands), so artwork
// can never wedge the phone companion on its own no matter how many tiles
// mount at once.
const ART_CACHE_MAX = 120;
const artObjects = new Map<string, string>(); // source url -> blob object url
const artInflight = new Map<string, Promise<string | null>>();

function evictOldestArt(): void {
  const oldest = artObjects.keys().next();
  if (oldest.done) return;
  const obj = artObjects.get(oldest.value);
  if (obj) URL.revokeObjectURL(obj);
  artObjects.delete(oldest.value);
}

function rememberArt(url: string, obj: string): void {
  const hit = artObjects.get(url);
  if (hit && hit !== obj) URL.revokeObjectURL(hit);
  else artObjects.delete(url);
  while (artObjects.size >= ART_CACHE_MAX) evictOldestArt();
  artObjects.set(url, obj); // (re-)inserted at the young end: LRU order
}

// Bumped whenever the art cache is cleared while the app is running. Every
// mounted useCachedArt subscribes and re-runs its load on bump, so no tile
// keeps rendering a revoked blob URL — art re-fetches fresh instead.
let artGen = 0;
const artGenListeners = new Set<() => void>();
export function bumpArtGen(): void {
  artGen++;
  for (const fn of [...artGenListeners]) fn();
}
function useArtGen(): number {
  return useSyncExternalStore(
    useCallback(
      (fn: () => void) => {
        artGenListeners.add(fn);
        return () => {
          artGenListeners.delete(fn);
        };
      },
      [],
    ),
    () => artGen,
  );
}

// Drops both art tiers: revokes the in-memory blob URLs and wipes the
// persistent daemon-store entries (same empty-value convention the LRU
// eviction itself uses). Callers bump the art generation afterwards so
// mounted tiles re-fetch instead of showing revoked URLs.
export async function clearArtCache(): Promise<void> {
  for (const obj of artObjects.values()) {
    try {
      URL.revokeObjectURL(obj);
    } catch {
      // ignore
    }
  }
  artObjects.clear();
  try {
    const client = getClient();
    const idxRaw = await persistRead(PART_INDEX);
    const idx: string[] = idxRaw ? (JSON.parse(idxRaw) as string[]) : [];
    await Promise.all(
      [...idx, PART_INDEX].map(k =>
        client.store.put({ key: k, value: '' }).catch(() => undefined),
      ),
    );
  } catch {
    // store unavailable: the memory tier was still cleared
  }
}

// ---- persistent art tier (daemon store, survives restarts) ----
const PART_PREFIX = 'finch:art:';
const PART_INDEX = 'finch:art:index';
const PART_MAX = 48;

function hashUrl(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function persistRead(key: string): Promise<string | null> {
  try {
    const r = await getClient().store.get({ key });
    if (r.ok && r.response.value) return r.response.value;
  } catch {
    // store unavailable: the memory tier still covers this session
  }
  return null;
}

// Write-through, fire-and-forget: a full/failed store must never break art.
function persistWriteArt(url: string, bytes: Uint8Array): void {
  void (async () => {
    try {
      const key = PART_PREFIX + hashUrl(url);
      const client = getClient();
      await client.store.put({ key, value: bytesToB64(bytes) });
      const idxRaw = await persistRead(PART_INDEX);
      const idx: string[] = idxRaw ? (JSON.parse(idxRaw) as string[]) : [];
      const at = idx.indexOf(key);
      if (at >= 0) idx.splice(at, 1);
      idx.push(key);
      while (idx.length > PART_MAX) {
        const old = idx.shift()!;
        if (old !== key) void client.store.put({ key: old, value: '' }).catch(() => {});
      }
      await client.store.put({ key: PART_INDEX, value: JSON.stringify(idx) });
    } catch {
      // ignore: memory tier still works
    }
  })();
}

async function fetchArtNetwork(url: string): Promise<string | null> {
  // Persistent tier before the network: a cold start reuses art it saw
  // in a previous session without touching the Bluetooth link at all.
  const saved = await persistRead(PART_PREFIX + hashUrl(url));
  if (saved) {
    // A concurrent fetch for this URL may have populated the memory tier
    // while we awaited the store: reuse its blob instead of minting (and
    // revoking) a duplicate — revoking breaks <img>s still loading it.
    const raced = artObjects.get(url);
    if (raced) {
      rememberArt(url, raced);
      return raced;
    }
    try {
      const obj = URL.createObjectURL(new Blob([b64ToBytes(saved)], { type: 'image/jpeg' }));
      rememberArt(url, obj);
      return obj;
    } catch {
      // corrupt entry: fall through to the network
    }
  }
  const res = await getClient().net.fetch({
    request: { url, method: 'GET', headers: [], body: null, timeoutMs: 15000, redirect: 'follow' },
  });
  if (!res.ok) return null;
  const r = res.response.response as { status: number; body?: Uint8Array };
  if (r.status >= 400 || !r.body?.length) return null;
  const srcBytes = r.body as Uint8Array<ArrayBufferLike>;
  const bytes = new Uint8Array(srcBytes.length); // copy: BlobPart needs Uint8Array<ArrayBuffer>
  bytes.set(srcBytes);
  // Same race guard after the network round-trip: the loser's bytes are
  // identical (same source URL), so share the winner's blob.
  const raced = artObjects.get(url);
  if (raced) {
    rememberArt(url, raced);
    return raced;
  }
  const obj = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  rememberArt(url, obj);
  persistWriteArt(url, bytes);
  return obj;
}

async function loadArt(
  url: string,
  priority: 'front' | 'back' = 'front',
  shouldSkip?: () => boolean,
): Promise<string | null> {
  const hit = artObjects.get(url);
  if (hit) {
    rememberArt(url, hit); // refresh LRU order
    return hit;
  }
  // Skippable loads (tile artwork) are NOT deduped via artInflight: a shared
  // load's skip-check belongs to another tile, so one tile scrolling away
  // could abandon art a still-visible tile needs. Completed art is still
  // shared via artObjects; the only cost is a rare duplicate in-flight fetch
  // (still gated to 3 slots).
  if (!shouldSkip) {
    const inflight = artInflight.get(url);
    if (inflight) return inflight;
  }
  // Demand loads jump to the FRONT of the net gate: something on screen now
  // (the Now Playing hero, a freshly mounted tile) beats background JSON.
  const p = gatedNet(() => fetchArtNetwork(url), priority, shouldSkip).finally(() => {
    if (artInflight.get(url) === p) artInflight.delete(url);
  });
  if (!shouldSkip) artInflight.set(url, p);
  return p;
}

// Prefetch generation: bumped to abandon a prefetch batch (e.g. the user
// switched tabs before it drained) so stale prefetches don't clog the queue.
let warmGen = 0;

// Pre-fetch a batch of artwork urls (e.g. a freshly loaded rail) so the
// images are already cached when their tiles mount. Capped and funneled
// through the same concurrency gate as on-demand loads; prefetch batches are
// abandoned when cancelWarmArt() runs (their queued slots are skipped before
// ever hitting the network).
export function warmArt(srcs: (string | null | undefined)[], limit = 48): void {
  const gen = warmGen;
  let n = 0;
  for (const s of srcs) {
    if (n >= limit) break;
    if (gen !== warmGen) break; // superseded mid-batch: stop enqueueing
    if (s && !artObjects.has(s) && !artInflight.has(s)) {
      n++;
      // Prefetch rides the BACK of the net gate; cancelWarmArt() bumps the
      // generation so a newer batch supersedes this one.
      const p = loadArt(s, 'back');
      artInflight.set(s, p);
      // Fire-and-forget: a Tile that mounts later picks the result up from
      // artInflight/artObjects. A skipped-stale prefetch resolves null and a
      // later demand load simply re-enqueues.
      void p.catch(() => {});
    }
  }
}

export function cancelWarmArt(): void {
  warmGen++;
}

export function useCachedArt(
  src: string | null,
  aliveRef?: { current: boolean },
): { url: string | null; failed: boolean } {
  const [obj, setObj] = useState<string | null>(() => (src ? (artObjects.get(src) ?? null) : null));
  const [failed, setFailed] = useState(false);
  // When the phone link returns after a drop, retry artwork that failed
  // mid-outage (the common "tile stuck on the note icon" case). Cache hits
  // return instantly below, so only missing/failed art re-hits the network.
  const linkGen = useLinkGen();
  const gen = useArtGen();
  useEffect(() => {
    if (!src) {
      setObj(null);
      setFailed(false);
      return;
    }
    let dead = false;
    setFailed(false);
    const hit = artObjects.get(src);
    if (hit) {
      setObj(hit);
      return;
    }
    setObj(null);
    // If the tile scrolls out of view while queued, abandon the fetch before
    // it touches the Bluetooth link (netgate shouldSkip). The dead flag still
    // guards the React side for loads already in flight.
    const shouldSkip = aliveRef ? () => !aliveRef.current : undefined;
    void loadArt(src, 'front', shouldSkip).then(o => {
      if (dead) return;
      if (o) setObj(o);
      else setFailed(true);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, linkGen, gen]);
  return { url: obj, failed };
}

// artwork resolution comes from the app, which owns the jellyfin client.
export interface ArtResolver {
  trackArt: (t: Track, w?: number) => string | null;
  albumArt: (a: Album, w?: number) => string | null;
  artistArt: (a: Artist, w?: number) => string | null;
  playlistArt: (p: Playlist, w?: number) => string | null;
}
export const ArtCtx = createContext<ArtResolver | null>(null);
export const useArt = (): ArtResolver | null => useContext(ArtCtx);

export function usePlayer(): number {
  return useSyncExternalStore(
    useCallback((fn: () => void) => player.subscribe(fn), []),
    () => player.revision,
  );
}

// Bumps whenever the phone's Bluetooth link drops or reconnects. Views use
// it to retry loads that failed mid-outage (artwork, lists) once the link is
// back, instead of parking on a failed placeholder forever.
export function useLinkGen(): number {
  const [gen, setGen] = useState(() => player.linkGeneration);
  useEffect(() => player.onLink(() => setGen(player.linkGeneration)), []);
  return gen;
}

// The daemon's raw transport errors ("network error: Handler failed |
// reason: 'Transport Channel Closed'") mean the phone link dropped
// mid-request. Say that instead of surfacing plumbing to the user.
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'could not load');
  if (/transport channel closed/i.test(msg)) return 'The phone link dropped while loading.';
  return msg;
}

export function detectPortrait(): boolean {
  try {
    if (screen.orientation?.type.startsWith('portrait')) return true;
  } catch {
    // older webview
  }
  try {
    if (window.matchMedia('(orientation: portrait)').matches) return true;
  } catch {
    // no matchMedia
  }
  return false;
}

export function usePortrait(): boolean {
  const [p, setP] = useState(detectPortrait);
  useEffect(() => {
    const update = (): void => setP(detectPortrait());
    window.addEventListener('orientationchange', update);
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(orientation: portrait)');
      mq.addEventListener('change', update);
    } catch {
      // ignore
    }
    return () => {
      window.removeEventListener('orientationchange', update);
      mq?.removeEventListener('change', update);
    };
  }, []);
  return p;
}

export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- icons (inline svg, currentColor) ----

const PATHS: Record<string, string> = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  next: 'M6 6l8.5 6L6 18zM16 6h2v12h-2z',
  prev: 'M18 6l-8.5 6L18 18zM6 6h2v12H6z',
  heart: 'M12 21s-7.5-4.7-10-9.3C.4 8.6 2.4 5 5.8 5c2 0 3.4 1.1 4.2 2.3h4c.8-1.2 2.2-2.3 4.2-2.3 3.4 0 5.4 3.6 3.8 6.7C19.5 16.3 12 21 12 21z',
  heartFill:
    'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-6h-2v4h-2v-6h4v2z',
  search: 'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  library:
    'M8.5,11H5.563a2.5,2.5,0,0,1-2.5-2.5V5.564a2.5,2.5,0,0,1,2.5-2.5H8.5a2.5,2.5,0,0,1,2.5,2.5V8.5A2.5,2.5,0,0,1,8.5,11ZM5.563,4.064a1.5,1.5,0,0,0-1.5,1.5V8.5a1.5,1.5,0,0,0,1.5,1.5H8.5A1.5,1.5,0,0,0,10,8.5V5.564a1.5,1.5,0,0,0-1.5-1.5Z M18.436,11H15.5A2.5,2.5,0,0,1,13,8.5V5.564a2.5,2.5,0,0,1,2.5-2.5h2.934a2.5,2.5,0,0,1,2.5,2.5V8.5A2.5,2.5,0,0,1,18.436,11ZM15.5,4.064a1.5,1.5,0,0,0-1.5,1.5V8.5A1.5,1.5,0,0,0,15.5,10h2.934a1.5,1.5,0,0,0,1.5-1.5V5.564a1.5,1.5,0,0,0-1.5-1.5Z M8.5,20.936H5.564a2.5,2.5,0,0,1-2.5-2.5V15.5a2.5,2.5,0,0,1,2.5-2.5H8.5A2.5,2.5,0,0,1,11,15.5v2.936A2.5,2.5,0,0,1,8.5,20.936ZM5.564,14a1.5,1.5,0,0,0-1.5,1.5v2.936a1.5,1.5,0,0,0,1.5,1.5H8.5a1.5,1.5,0,0,0,1.5-1.5V15.5A1.5,1.5,0,0,0,8.5,14Z M18.436,20.936H15.5a2.5,2.5,0,0,1-2.5-2.5V15.5A2.5,2.5,0,0,1,15.5,13h2.934a2.5,2.5,0,0,1,2.5,2.5v2.936A2.5,2.5,0,0,1,18.436,20.936ZM15.5,14A1.5,1.5,0,0,0,14,15.5v2.936a1.5,1.5,0,0,0,1.5,1.5h2.934a1.5,1.5,0,0,0,1.5-1.5V15.5a1.5,1.5,0,0,0-1.5-1.5Z',
  queue: 'M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zM16 9l6 3-6 3z',
  playlist:
    'M3 6h8v2H3zM3 10.5h8v2H3zM3 15h5v2H3zM16 4v10.55A4 4 0 1 0 18 18V8h4V4h-6z',
  album:
    'M7 10H17A3 3 0 0 1 20 13V18A3 3 0 0 1 17 21H7A3 3 0 0 1 4 18V13A3 3 0 0 1 7 10Z M8.2 12.2A1.8 1.8 0 0 0 6.4 14V16.8A1.8 1.8 0 0 0 8.2 18.6H15.8A1.8 1.8 0 0 0 17.6 16.8V14A1.8 1.8 0 0 0 15.8 12.2Z M7.2 7.1H16.8A1.1 1.1 0 0 1 16.8 9.3H7.2A1.1 1.1 0 0 1 7.2 7.1Z M8.8 3.9H15.2A1.1 1.1 0 0 1 15.2 6.1H8.8A1.1 1.1 0 0 1 8.8 3.9Z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  x: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  dots: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  volUp: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.47 4.47 0 0 0 16.5 12z',
  volDown: 'M3 9v6h4l5 5V4L7 9H3z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z',
  lyrics:
    'M16.5,7h-9a1,1,0,0,1,0,-2h9a1,1,0,0,1,0,2Z M20.437,13H3.563a1,1,0,0,1,0,-2H20.437a1,1,0,0,1,0,2Z M16.5,19h-9a1,1,0,0,1,0,-2h9a1,1,0,0,1,0,2Z',
  mix: 'M3 5h2v14H3zm5 0h2v14H5zm4 0h2v9H9zm5 0h2v14h-2zm4 0h2v5h-2z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.59l-4.24 4.25-1.42-1.42L11 11.76V6h1v6.59z',
  mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z',
};

export function Icon({ name, size = 28, className = '' }: { name: keyof typeof PATHS; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

// Transport glyphs from the o-music player (ousachea/Ousa-Music-Player-v1):
// the play triangle is optically centered, pause is two rounded bars, skip
// is two solid triangles (mirrored at the usage site for previous). Used for
// the Now Playing transport as plain buttons with no circle backgrounds.
export function TransportGlyph({ name, className = '' }: { name: 'play' | 'pause' | 'skip'; className?: string }) {
  if (name === 'play') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
        <path
          transform="translate(-1.6 0)"
          d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.7-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z"
        />
      </svg>
    );
  }
  if (name === 'pause') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
        <rect x="5.5" y="3.5" width="4.6" height="17" rx="0.9" />
        <rect x="13.9" y="3.5" width="4.6" height="17" rx="0.9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M1.6 5.6v12.8a0.9 0.9 0 0 0 1.38.76l9.6-6.4a0.9 0.9 0 0 0 0-1.52l-9.6-6.4a0.9 0.9 0 0 0-1.38.76Z" />
      <path d="M11.4 5.6v12.8a0.9 0.9 0 0 0 1.38.76l9.6-6.4a0.9 0.9 0 0 0 0-1.52l-9.6-6.4a0.9 0.9 0 0 0-1.38.76Z" />
    </svg>
  );
}

// ---- artwork ----

export function Artwork({
  src,
  size,
  rounded = 'rounded-xl',
  label = '',
  fluid = false,
}: {
  src: string | null;
  size: number;
  rounded?: string;
  label?: string;
  fluid?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // Lazy-load: only fetch artwork when the tile is near the viewport. The
  // library grid mounts hundreds of tiles at once; without this every one of
  // them fires a Bluetooth-tunnelled image fetch on mount and the burst knocks
  // the phone link over. The 400px margin preloads just ahead of scroll.
  // The observer stays connected (no disconnect after the first hit) so a
  // tile that scrolls back out of range flips nearRef to false — its still-
  // queued art fetch is then abandoned before touching the network (see
  // useCachedArt's shouldSkip). Scrolling back in re-triggers the load.
  const nearRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      nearRef.current = true;
      return;
    }
    const ob = new IntersectionObserver(
      entries => {
        const isNear = entries.some(e => e.isIntersecting);
        nearRef.current = isNear;
        setNear(isNear);
      },
      { rootMargin: '400px' },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  const { url, failed } = useCachedArt(near ? src : null, nearRef);
  return (
    <div
      ref={ref}
      className="shrink-0"
      style={fluid ? { width: '100%', aspectRatio: '1 / 1' } : { width: size, height: size }}
    >
      {!src || failed || !url ? (
        <div
          className={`flex h-full w-full items-center justify-center bg-white/8 text-white/25 ${rounded}`}
          aria-label={label}
        >
          <Icon name="note" size={Math.round(size * 0.4)} />
        </div>
      ) : (
        <img
          src={url}
          width={size}
          height={size}
          draggable={false}
          className={`h-full w-full object-cover ${rounded}`}
          alt={label}
        />
      )}
    </div>
  );
}

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

export function TopBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  const portrait = usePortrait();
  return (
    <div
      className={`flex shrink-0 items-center gap-3 border-b border-white/10 px-4 ${
        portrait ? 'h-14' : 'h-20'
      }`}
    >
      {onBack ? (
        <IconBtn onClick={onBack} label="Back" size={portrait ? 44 : 56}>
          <Icon name="back" size={portrait ? 24 : 30} />
        </IconBtn>
      ) : null}
      <h1 className={`min-w-0 flex-1 truncate font-semibold ${portrait ? 'text-xl' : 'text-2xl'}`}>
        {title}
      </h1>
      {right}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-white/50">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/15 border-t-gold" />
      <div className="text-xl">{label}</div>
    </div>
  );
}

export function Empty({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
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

// Shown when the server rejected the credentials: the error text plus a way
// back to sign-in (Quick Connect / API key), since Setup is otherwise only
// reachable when no credentials exist at all.
export function AuthError({ text, onReconnect }: { text: string; onReconnect: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="text-xl leading-relaxed text-white/60">{text}</div>
      <button
        type="button"
        data-focusable
        onClick={onReconnect}
        className="rounded-2xl bg-leaf px-8 py-4 text-xl font-bold text-black active:brightness-90"
      >
        Reconnect
      </button>
    </div>
  );
}

// ---- tiles & rows ----

// Horizontal rail section: small-caps title, optional gold "See all", and a
// fixed row of tiles that evenly fills the full width (each tile flexes to an
// equal share, so there is never blank space at the row's end).
export function Rail({
  title,
  onSeeAll,
  children,
}: {
  title: string;
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7 shrink-0">
      <div className="relative mb-3 flex items-center px-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.22em] text-white/80">{title}</h2>
        {onSeeAll ? (
          <button
            type="button"
            data-focusable
            onClick={onSeeAll}
            className="absolute top-1/2 right-5 -translate-y-1/2 rounded-full px-4 py-2 text-lg font-medium text-goldlight active:bg-white/10"
          >
            See all
          </button>
        ) : null}
      </div>
      <div className="flex gap-4 overflow-hidden px-5 pb-1 [&>*]:min-w-0 [&>*]:grow-0 [&>*]:basis-[calc((100%-4rem)/5)]">{children}</div>
    </section>
  );
}

export function Tile({
  title,
  subtitle,
  art,
  onClick,
  onMenu,
  active,
  size = 160,
  fluid = false,
}: {
  title: string;
  subtitle?: string;
  art: string | null;
  onClick: () => void;
  onMenu?: () => void;
  active?: boolean;
  size?: number;
  fluid?: boolean;
}) {
  return (
    <div className={fluid ? 'relative min-w-0' : 'relative shrink-0'} style={fluid ? undefined : { width: size }}>
      <button type="button" data-focusable onClick={onClick} className="block w-full text-left active:opacity-80">
        <div data-glow-target className={active ? 'rounded-2xl ring-2 ring-inset ring-leaf' : 'rounded-2xl'}>
          <Artwork src={art} size={size} rounded="rounded-2xl" label={title} fluid={fluid} />
        </div>
        <div className={`mt-2 truncate text-lg leading-tight font-medium ${active ? 'text-leaf' : ''}`}>{title}</div>
        {subtitle ? <div className="truncate text-base leading-tight text-white/50">{subtitle}</div> : null}
      </button>
      {onMenu ? (
        <button
          type="button"
          data-focusable
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
}

export function TrackRow({
  track,
  art,
  onPlay,
  onToggle,
  onMenu,
  showArt = true,
  indexLabel,
}: {
  track: Track;
  art: string | null;
  onPlay: () => void;
  onToggle?: () => void;
  onMenu?: () => void;
  showArt?: boolean;
  indexLabel?: string;
}) {
  usePlayer();
  const active = player.current()?.id === track.id;
  const toggle = onToggle ?? onPlay;
  return (
    <div
      className={`flex min-h-16 items-center gap-3 rounded-2xl px-2.5 py-2 ${active ? 'bg-leaf/10' : 'active:bg-white/8'}`}
    >
      <button type="button" data-focusable onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {showArt ? (
          <Artwork src={art} size={56} rounded="rounded-2xl" label={track.album} />
        ) : indexLabel ? (
          <span className="w-10 shrink-0 text-center text-xl text-white/40">{indexLabel}</span>
        ) : null}
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xl leading-tight ${active ? 'text-leaf' : ''}`}>
            {track.name}
          </span>
          <span className="block truncate text-base leading-tight text-white/50">
            {track.artist} {track.album ? `· ${track.album}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-base text-white/40">{fmtTime(track.durationMs)}</span>
      </button>
      <button
        type="button"
        data-focusable
        aria-label={`${active && player.intentPlaying ? 'Pause' : 'Play'} ${track.name}`}
        onClick={toggle}
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white/70 active:bg-white/15"
      >
        <Icon name={active && player.intentPlaying ? 'pause' : 'play'} size={30} />
      </button>
      {onMenu ? (
        <button
          type="button"
          data-focusable
          aria-label={`More options for ${track.name}`}
          onClick={onMenu}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white/70 active:bg-white/15"
        >
          <Icon name="dots" size={28} />
        </button>
      ) : null}
    </div>
  );
}

// ---- progress bar with tap/drag seek ----

// o-music's bare-glyph button: the padding is the only hit area a bare
// glyph has, and the negative margin keeps it off the layout. Remounting on
// the tap counter replays the tap keyframes on every press.
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
  // opts into default knob-click focus: the focus engine lands on this
  // button first when the view opens.
  focusDefault?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [tap, bump] = useState(0);
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-focusable={disabled ? undefined : true}
      data-focus-default={focusDefault ? true : undefined}
      onPointerDown={() => bump(n => n + 1)}
      onClick={onClick}
      style={tint ? { color: tint } : undefined}
      className={`-m-3 shrink-0 p-3 text-[#efefef] transition-[transform,color] duration-300 ease-spring active:scale-90 disabled:opacity-30 ${className}`}
    >
      <span key={tap} className="grid animate-tap place-items-center">
        {children}
      </span>
    </button>
  );
}

export function ProgressBar({ onSeek }: { onSeek: (ms: number) => void }) {
  usePlayer();
  const barRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  // While the finger is down the bar follows it locally; the phone hears
  // about the seek exactly once, on release. Firing a seek per pointermove
  // trips the daemon's rate limiter ("Rate limit exceeded" error overlay).
  const [dragMs, setDragMs] = useState<number | null>(null);
  const dur = player.trackDurationMs;

  useEffect(() => {
    if (!player.intentPlaying) return;
    let raf = 0;
    const tick = (): void => {
      force(n => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player.intentPlaying]);

  // The position the bar (and times) show: the finger while dragging, the
  // player clock otherwise.
  const shown = dragMs ?? player.positionNow();
  const ratio = dur > 0 ? Math.min(1, Math.max(0, shown / dur)) : 0;

  const msFromEvent = (clientX: number): number | null => {
    const el = barRef.current;
    if (!el || dur <= 0) return null;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return p * dur;
  };

  return (
    <div className="w-full">
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(shown)}
        // slim o-music-style rail: 3px track, 12px dot. The -my-3/py-3 keeps
        // a 48px touch target while the layout footprint stays 24px.
        className="relative -my-3 flex h-6 w-full cursor-pointer touch-none items-center py-3"
        onPointerDown={e => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const ms = msFromEvent(e.clientX);
          if (ms !== null) setDragMs(ms);
        }}
        onPointerMove={e => {
          if (dragMs === null) return;
          const ms = msFromEvent(e.clientX);
          if (ms !== null) setDragMs(ms);
        }}
        onPointerUp={e => {
          const ms = msFromEvent(e.clientX) ?? dragMs;
          setDragMs(null);
          if (ms !== null) onSeek(ms);
        }}
        onPointerCancel={() => setDragMs(null)}
      >
        <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-white/18">
          <div
            className="relative h-full overflow-hidden rounded-full bg-gold"
            style={{ width: `${ratio * 100}%` }}
          >
            {player.intentPlaying && (
              <div className="absolute inset-y-0 w-1/3 animate-sheen bg-gradient-to-r from-transparent via-white/70 to-transparent" />
            )}
          </div>
        </div>
        {player.intentPlaying && (
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 animate-halo rounded-full bg-goldlight"
            style={{ left: `${ratio * 100}%` }}
          />
        )}
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-goldlight shadow"
          style={{ left: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[0.75rem] tabular-nums text-white/35">
        <span>{fmtTime(shown)}</span>
        <span>-{fmtTime(Math.max(0, dur - shown))}</span>
      </div>
    </div>
  );
}

// ---- context menu (bottom sheet) ----

export interface MenuAction {
  label: string;
  icon: keyof typeof PATHS;
  run: () => void;
  danger?: boolean;
}

export function MenuSheet({ title, actions, onClose }: { title: string; actions: MenuAction[]; onClose: () => void }) {
  return (
    <FocusScope>
      <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/70" onClick={onClose}>
        <div className="max-h-[85%] w-full overflow-y-auto" onClick={e => e.stopPropagation()}>
          <GlassPanel className="rounded-t-3xl p-4 pb-6">
            <div className="mb-3 truncate px-2 text-2xl font-semibold">{title}</div>
            {actions.map(a => (
              <button
                key={a.label}
                type="button"
                data-focusable
                onClick={() => {
                  onClose();
                  a.run();
                }}
                className={`mb-2 flex h-18 w-full items-center gap-4 rounded-2xl px-4 text-left text-2xl active:bg-white/10 ${
                  a.danger ? 'text-red-400' : ''
                }`}
              >
                <Icon name={a.icon} size={30} />
                {a.label}
              </button>
            ))}
            <button
              type="button"
              data-focusable
              onClick={onClose}
              className="mt-2 flex h-18 w-full items-center justify-center gap-3 rounded-2xl bg-white/10 text-2xl font-medium active:bg-white/20"
            >
              <Icon name="x" size={28} /> Cancel
            </button>
          </GlassPanel>
        </div>
      </div>
    </FocusScope>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ title: string; actions: MenuAction[] } | null>(null);
  const sheet = menu ? <MenuSheet title={menu.title} actions={menu.actions} onClose={() => setMenu(null)} /> : null;
  return useMemo(() => ({ open: setMenu, sheet }), [sheet]);
}

// ---- option-B skin: bigger rounded cards, motion, art accents ----

export function GridCard({
  art,
  title,
  subtitle,
  onClick,
  onMenu,
  active,
}: {
  art: string | null;
  title: string;
  subtitle?: string;
  onClick: () => void;
  onMenu?: () => void;
  active?: boolean;
}) {
  return (
    <div className="relative cursor-pointer" onClick={onClick} data-focusable role="button" tabIndex={-1}>
      <div data-glow-target className={active ? 'rounded-2xl ring-2 ring-inset ring-leaf' : 'rounded-2xl'}>
        <Artwork src={art} size={320} rounded="rounded-2xl" label={title} fluid />
      </div>
      <div className={`mt-2 truncate px-1 text-lg leading-tight font-semibold ${active ? 'text-leaf' : ''}`}>
        {title}
      </div>
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
}

export function Rise({ i = 0, className = '', children }: { i?: number; className?: string; children: ReactNode }) {
  return (
    <div className={`animate-rise ${className}`} style={{ animationDelay: `${Math.min(i, 7) * 45}ms` }}>
      {children}
    </div>
  );
}

export function SkeletonTile({ size = 180, fluid = false }: { size?: number; fluid?: boolean }) {
  return (
    <div className={fluid ? 'min-w-0' : 'shrink-0'} style={fluid ? undefined : { width: size }} aria-hidden>
      <div
        className={`skeleton rounded-2xl ${fluid ? 'aspect-square w-full' : ''}`}
        style={fluid ? undefined : { width: size, height: size }}
      />
      <div className="skeleton mt-2 h-6 w-4/5 rounded-md" />
      <div className="skeleton mt-1.5 h-5 w-3/5 rounded-md" />
    </div>
  );
}

export function SkeletonGridCard() {
  return (
    <div aria-hidden>
      <div className="skeleton aspect-square w-full rounded-2xl" />
      <div className="skeleton mt-2 h-6 w-4/5 rounded-md" />
      <div className="skeleton mt-1.5 h-5 w-3/5 rounded-md" />
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

/* Dominant-color accent, sampled from a track's artwork once and cached.
   Feeds the "accent from album art" parts of the skin: play buttons,
   ambient glows, detail-header tints. Null until sampled. */
const accentCache = new Map<string, string>();
export function useArtAccent(src: string | null): string | null {
  const [color, setColor] = useState<string | null>(() =>
    src ? (accentCache.get(src) ?? null) : null,
  );
  useEffect(() => {
    if (!src) {
      setColor(null);
      return;
    }
    const hit = accentCache.get(src);
    if (hit) {
      setColor(hit);
      return;
    }
    let dead = false;
    void loadArt(src).then(obj => {
      if (dead || !obj) return;
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 32;
          c.height = 32;
          const ctx = c.getContext('2d');
          if (!ctx || dead) return;
          ctx.drawImage(img, 0, 0, 32, 32);
          const d = ctx.getImageData(0, 0, 32, 32).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 32) {
            if (d[i + 3] < 128) continue;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            n++;
          }
          if (!n || dead) return;
          r = Math.round(r / n);
          g = Math.round(g / n);
          b = Math.round(b / n);
          // lift the average so dark/muddy covers still read as a color
          const mx = Math.max(r, g, b, 1);
          const boost = Math.min(1.6, 200 / mx);
          r = Math.min(255, Math.round(r * boost));
          g = Math.min(255, Math.round(g * boost));
          b = Math.min(255, Math.round(b * boost));
          const col = `rgb(${r}, ${g}, ${b})`;
          accentCache.set(src, col);
          if (!dead) setColor(col);
        } catch {
          /* canvas tainted or art missing — accent stays null */
        }
      };
      img.onerror = () => {};
      img.src = obj;
    });
    return () => {
      dead = true;
    };
  }, [src]);
  return color;
}

/* Ambient blurred-artwork backdrop: the source art blown up and blurred
   behind a scrim, plus an optional art-accent glow. Pinned to the top of
   the scrolling view it wraps. */
export function AmbientArt({
  src,
  accent,
  height = 320,
  fixed = false,
}: {
  src: string | null;
  accent?: string | null;
  height?: number;
  // fixed pins the backdrop to the viewport so it paints behind the top tab
  // strip too (the strip is transparent); absolute stays inside the view's
  // own scroll container, e.g. the Detail header.
  fixed?: boolean;
}) {
  const { url } = useCachedArt(src);
  if (!url) return null;
  return (
    <div
      className={`pointer-events-none ${fixed ? 'fixed' : 'absolute'} inset-x-0 top-0 overflow-hidden`}
      style={{ height }}
      aria-hidden
    >
      <img
        src={url}
        className="h-full w-full scale-150 object-cover opacity-40 blur-3xl"
        draggable={false}
      />
      {accent && (
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background: `radial-gradient(120% 90% at 50% 0%, ${accent} 0%, transparent 70%)`,
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-zinc-950/30 to-zinc-950" />
    </div>
  );
}

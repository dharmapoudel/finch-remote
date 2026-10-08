// Finch 1.4.1: a small on-device cache that survives app restarts.
//
// One IndexedDB database, two stores:
//   art   - image bytes keyed by `${id}:${tag}:${size}` (the art.ts key),
//           capped at ART_MAX_BYTES / ART_MAX_ENTRIES, oldest-used evicted.
//   lists - the last-loaded Home / tab / detail lists (JSON), capped at
//           LIST_MAX_ENTRIES, oldest evicted.
//
// Lists are also mirrored, in one small JSON value, to the daemon's own
// key-value store (client.store, where Finch keeps its other settings), in
// case the webview's storage does not survive a restart on the device.
//
// Lean on purpose: no tiers, no refcounts. Everything here is best effort;
// if IndexedDB is missing, blocked or full, every call resolves to "miss"
// and Finch behaves exactly like 1.4.0 (memory only).

const DB_NAME = 'finch-cache';
const DB_VERSION = 1;

export const ART_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB of thumbnails/heroes
export const ART_MAX_ENTRIES = 900;
const LIST_MAX_ENTRIES = 60;
const LIST_MAX_BYTES = 256 * 1024; // per list (JSON chars); bigger lists are not kept
const LOCAL_MAX_BYTES = 1024 * 1024; // per pinned local-only record
const TOUCH_AFTER_MS = 12 * 3600 * 1000; // refresh an entry's "last used" at most twice a day

type ArtRec = { d: ArrayBuffer; m: string; n: number; t: number };
// p: pinned (small records Finch writes itself, e.g. recently played
// playlists): never evicted by the list LRU, mirrored to client.store first.
// l: local only (rebuildable, e.g. the playlist index): not mirrored to client.store,
// and allowed up to LOCAL_MAX_BYTES.
type ListRec = { v: unknown; t: number; p?: 1; l?: 1 };

let dbp: Promise<IDBDatabase | null> | null = null;
let artBytes = 0;
const artIndex = new Map<string, { n: number; t: number }>();
let artBudget = ART_MAX_BYTES;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase | null>(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      const fail = window.setTimeout(() => resolve(null), 1500); // a wedged IDB must not hold up the app
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('art')) db.createObjectStore('art');
        if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists');
      };
      r.onsuccess = () => {
        window.clearTimeout(fail);
        resolve(r.result);
      };
      r.onerror = () => {
        window.clearTimeout(fail);
        resolve(null);
      };
      r.onblocked = () => {
        window.clearTimeout(fail);
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  }).then(async db => {
    if (!db) return null;
    try {
      await loadArtIndex(db);
      // Stay well inside whatever the webview grants this origin.
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) artBudget = Math.max(2 * 1024 * 1024, Math.min(ART_MAX_BYTES, Math.floor(est.quota * 0.25)));
    } catch {
      /* index or estimate unavailable: still usable */
    }
    return db;
  });
  return dbp;
}

/** Walk the art store once at start-up for sizes and ages (no image bytes are decoded). */
async function loadArtIndex(db: IDBDatabase): Promise<void> {
  await new Promise<void>(resolve => {
    try {
      const cur = db.transaction('art', 'readonly').objectStore('art').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const v = c.value as ArtRec;
        artIndex.set(String(c.key), { n: v.n, t: v.t });
        artBytes += v.n;
        c.continue();
      };
      cur.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Resolves once the database (and the list snapshot) is ready, or failed. */
export const ready: Promise<void> = (async () => {
  const db = await open();
  if (db) await primeLists(db);
})();

// ---------------------------------------------------------------------------
// art

export async function getArt(key: string): Promise<Blob | null> {
  if (!artIndex.has(key)) return null; // fast miss without a transaction
  const db = await open();
  if (!db) return null;
  try {
    const rec = (await req(db.transaction('art', 'readonly').objectStore('art').get(key))) as ArtRec | undefined;
    if (!rec) {
      artIndex.delete(key);
      return null;
    }
    const now = Date.now();
    if (now - rec.t > TOUCH_AFTER_MS) {
      rec.t = now;
      artIndex.set(key, { n: rec.n, t: now });
      void db.transaction('art', 'readwrite').objectStore('art').put(rec, key);
    }
    return new Blob([rec.d], { type: rec.m });
  } catch {
    return null;
  }
}

export function hasArt(key: string): boolean {
  return artIndex.has(key);
}

export async function putArt(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (artIndex.has(key)) return;
  const n = bytes.byteLength;
  if (n === 0 || n > 512 * 1024) return; // one oversized image would push out dozens
  const db = await open();
  if (!db) return;
  try {
    const d = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n) as ArrayBuffer;
    const t = Date.now();
    await txDone(db, 'art', s => s.put({ d, m: mime, n, t } satisfies ArtRec, key));
    artIndex.set(key, { n, t });
    artBytes += n;
    if (artBytes > artBudget || artIndex.size > ART_MAX_ENTRIES) scheduleEvict();
  } catch {
    /* quota or write failure: ignore, memory cache still works */
    scheduleEvict();
  }
}

let evictTimer: number | null = null;
function scheduleEvict(): void {
  if (evictTimer !== null) return;
  evictTimer = window.setTimeout(() => {
    evictTimer = null;
    void evictArt();
  }, 2000);
}

/** Drop least-recently-used entries until 85% of the budget. */
async function evictArt(): Promise<void> {
  const db = await open();
  if (!db) return;
  const targetBytes = artBudget * 0.85;
  const targetN = ART_MAX_ENTRIES * 0.85;
  if (artBytes <= targetBytes && artIndex.size <= targetN) return;
  const byAge = [...artIndex.entries()].sort((a, b) => a[1].t - b[1].t);
  const drop: string[] = [];
  let bytes = artBytes;
  let count = artIndex.size;
  for (const [k, v] of byAge) {
    if (bytes <= targetBytes && count <= targetN) break;
    drop.push(k);
    bytes -= v.n;
    count--;
  }
  try {
    await txDone(db, 'art', s => drop.forEach(k => s.delete(k)));
    for (const k of drop) {
      artBytes -= artIndex.get(k)?.n ?? 0;
      artIndex.delete(k);
    }
  } catch {
    /* try again next time */
  }
}

// ---------------------------------------------------------------------------
// lists

/** In-memory copy of the list store, filled before the first render. */
const lists = new Map<string, ListRec>();

async function primeLists(db: IDBDatabase): Promise<void> {
  await new Promise<void>(resolve => {
    try {
      const cur = db.transaction('lists', 'readonly').objectStore('lists').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        lists.set(String(c.key), c.value as ListRec);
        c.continue();
      };
      cur.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function getList<T>(key: string): T | undefined {
  return lists.get(key)?.v as T | undefined;
}

let listWrites = new Map<string, ListRec | null>();
let listTimer: number | null = null;

/** Remember a list; written to disk in one batch shortly after. */
export function putList(key: string, v: unknown, pin: boolean | 'local' = false): void {
  try {
    if (JSON.stringify(v).length > (pin === 'local' ? LOCAL_MAX_BYTES : LIST_MAX_BYTES)) return;
  } catch {
    return;
  }
  const rec: ListRec = pin === 'local' ? { v, t: Date.now(), p: 1, l: 1 } : pin ? { v, t: Date.now(), p: 1 } : { v, t: Date.now() };
  lists.set(key, rec);
  listWrites.set(key, rec);
  if (lists.size > LIST_MAX_ENTRIES) {
    const old = [...lists.entries()]
      .filter(e => !e[1].p)
      .sort((a, b) => a[1].t - b[1].t)
      .slice(0, lists.size - LIST_MAX_ENTRIES);
    for (const [k] of old) {
      lists.delete(k);
      listWrites.set(k, null);
    }
  }
  if (listTimer === null) listTimer = window.setTimeout(flushLists, 800);
}

async function flushLists(): Promise<void> {
  listTimer = null;
  const batch = listWrites;
  listWrites = new Map();
  void mirrorToKv();
  const db = await open();
  if (!db) return;
  try {
    await txDone(db, 'lists', s => batch.forEach((rec, k) => (rec ? s.put(rec, k) : s.delete(k))));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// daemon key-value mirror for the lists (no images: they would not fit)

type Kv = { get: (key: string) => Promise<string | null>; put: (key: string, value: string) => Promise<void> };
const KV_KEY = 'list_cache';
const KV_MAX_CHARS = 192 * 1024;
let kv: Kv | null = null;

/** Called by App once the daemon connection is up. Fills in any lists the
 *  webview's own storage lost (e.g. it was wiped), without overwriting newer ones. */
export async function attachKv(store: Kv): Promise<void> {
  kv = store;
  try {
    const raw = await store.get(KV_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, ListRec>;
    for (const [k, rec] of Object.entries(saved)) {
      const cur = lists.get(k);
      if (!cur || cur.t < rec.t) lists.set(k, rec);
    }
  } catch {
    /* unreadable mirror: ignore */
  }
}

let kvTimer: number | null = null;
function mirrorToKv(): void {
  if (!kv || kvTimer !== null) return;
  kvTimer = window.setTimeout(() => {
    kvTimer = null;
    if (!kv) return;
    // newest first until the size budget is used up
    const out: Record<string, ListRec> = {};
    let size = 2;
    for (const [k, rec] of [...lists.entries()].sort((a, b) => (b[1].p ?? 0) - (a[1].p ?? 0) || b[1].t - a[1].t)) {
      if (rec.l) continue;
      const len = JSON.stringify(rec).length + k.length + 4;
      if (size + len > KV_MAX_CHARS) continue;
      out[k] = rec;
      size += len;
    }
    void kv.put(KV_KEY, JSON.stringify(out)).catch(() => {});
  }, 3000);
}

// ---------------------------------------------------------------------------
// small boot record (which account the cached lists belong to)

const BOOT_KEY = 'finch:boot';
export function readBoot(): { user: string } | null {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    return raw ? (JSON.parse(raw) as { user: string }) : null;
  } catch {
    return null;
  }
}
export function writeBoot(user: string | null): void {
  try {
    if (user) localStorage.setItem(BOOT_KEY, JSON.stringify({ user }));
    else localStorage.removeItem(BOOT_KEY);
  } catch {
    /* no localStorage: start-up just waits for the daemon as before */
  }
}

function txDone(db: IDBDatabase, store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    fn(tx.objectStore(store));
  });
}

/** Diagnostics for headless QA (sizes only, no user data). */
export function cacheStats(): { artEntries: number; artBytes: number; artBudget: number; lists: number } {
  return { artEntries: artIndex.size, artBytes, artBudget, lists: lists.size };
}
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__finchCache = cacheStats;

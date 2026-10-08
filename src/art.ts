import { useEffect, useState } from 'react';
import type { Api } from './demo';
import type { Item } from './jellyfin';
import { getArt, hasArt, putArt } from './persist';

// ---------------------------------------------------------------------------
// artwork: blob URLs fetched through the phone, cached, max 4 in flight.
// Finch 1.3.1's loader; 1.4.1 adds one step: before going to the network it
// looks in the on-device cache (persist.ts), and every image it downloads is
// written there, so art paints straight away after an app restart.

const artCache = new Map<string, string>();
const artWaiters = new Map<string, Promise<string | null>>();
let artInFlight = 0;
const artQueue: (() => void)[] = [];
const ART_CACHE_MAX = 220;
let netCount = 0; // images fetched from Jellyfin this session (QA counter)

/** Sizes requested from Jellyfin. Tiles render at ~140px, heroes at 440px. */
export const TILE_PX = 160;
export const THUMB_PX = 96;
export const HERO_PX = 280;

export function artKey(item: Item, size: number): string | null {
  const tag = item.ImageTags?.Primary ?? item.AlbumPrimaryImageTag;
  if (!tag) return null;
  const id = item.ImageTags?.Primary ? item.Id : (item.AlbumId ?? item.Id);
  return `${id}:${tag}:${size}`;
}

export function cachedArt(item: Item | null | undefined, size: number): string | null {
  const key = item ? artKey(item, size) : null;
  return key ? (artCache.get(key) ?? null) : null;
}

function remember(key: string, url: string): void {
  artCache.set(key, url);
  if (artCache.size > ART_CACHE_MAX) {
    const oldest = artCache.keys().next().value as string;
    URL.revokeObjectURL(artCache.get(oldest)!);
    artCache.delete(oldest);
  }
}

/** Disk only (no api needed): lets cached screens paint before the daemon is up. */
function loadArtFromDisk(key: string): Promise<string | null> {
  const pending = artWaiters.get(key);
  if (pending) return pending;
  const p = getArt(key).then(blob => {
    artWaiters.delete(key);
    if (!blob) return null;
    const hit = artCache.get(key);
    if (hit) return hit;
    const url = URL.createObjectURL(blob);
    remember(key, url);
    return url;
  });
  artWaiters.set(key, p);
  return p;
}

export function loadArt(api: Api | null, item: Item, size: number): Promise<string | null> {
  const key = artKey(item, size);
  if (!key) return Promise.resolve(null);
  const hit = artCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = artWaiters.get(key);
  if (pending) return pending;
  if (hasArt(key)) {
    return loadArtFromDisk(key).then(u => u ?? (api ? loadArt(api, item, size) : null));
  }
  if (!api) return Promise.resolve(null);
  const p = new Promise<string | null>(resolve => {
    const run = async () => {
      artInFlight++;
      try {
        netCount++;
        const res = await api.image(item, size);
        if (!res) return resolve(null);
        const url = URL.createObjectURL(new Blob([res.bytes as BlobPart], { type: res.mime }));
        remember(key, url);
        void putArt(key, res.bytes, res.mime);
        resolve(url);
      } catch {
        resolve(null);
      } finally {
        artInFlight--;
        artWaiters.delete(key);
        artQueue.shift()?.();
      }
    };
    if (artInFlight < 4) void run();
    else artQueue.push(() => void run());
  });
  artWaiters.set(key, p);
  return p;
}

export function useArtUrl(api: Api | null, item: Item | null | undefined, size: number, enabled = true): string | null {
  const key = item ? artKey(item, size) : null;
  const [url, setUrl] = useState<string | null>(key ? (artCache.get(key) ?? null) : null);
  useEffect(() => {
    if (!item || !key) {
      setUrl(null);
      return;
    }
    const hit = artCache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    if (!enabled) return;
    if (!api && !hasArt(key)) return;
    let live = true;
    void loadArt(api, item, size).then(u => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [api, item, key, size, enabled]);
  return url;
}

/** Art requests running or waiting (background work yields to them). */
export function artBusy(): number {
  return artInFlight + artQueue.length;
}

if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__finchArtNet = () => netCount;

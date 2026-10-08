// Finch 1.4.3: the little bits of "recently played" state Finch keeps itself.
//
// - Jellyfin keeps track history (UserData.LastPlayedDate, stamped when the
//   player reports a play), but almost no player stamps playlists. Playlists
//   played anywhere are found from the track history (playlistIndex.ts); on
//   top of that Finch remembers the last 30 playlists started FROM FINCH
//   (exact, even before the index is built), in the persistent list
//   cache (persist.ts, pinned so the list LRU never drops it; mirrored to
//   client.store like the other lists). Server DatePlayed entries, when a
//   server has them, are merged in by date.
// - A tiny change signal: App bumps it (debounced) when the playing track
//   changes and Finch records a playlist start, and the rows that show
//   recents reload. Nothing polls.
import type { Api } from './demo';
import type { Item } from './jellyfin';
import { getList, putList } from './persist';

const MAX = 30;
type Rec = { item: Item; t: number };

const keyOf = (userKey: string) => `${userKey}:local:recent-playlists`;

/** Only the fields a tile needs (keeps the pinned record small). */
function slim(p: Item): Item {
  return {
    Id: p.Id,
    Name: p.Name,
    Type: 'Playlist',
    ChildCount: p.ChildCount,
    ImageTags: p.ImageTags?.Primary ? { Primary: p.ImageTags.Primary } : undefined,
    AlbumId: p.AlbumId,
    AlbumPrimaryImageTag: p.AlbumPrimaryImageTag,
  };
}

export function localRecentPlaylists(userKey: string): Rec[] {
  return (userKey && getList<Rec[]>(keyOf(userKey))) || [];
}

/** Call when a playlist starts playing from Finch (Play, Shuffle, a track in it). */
export function notePlaylistPlayed(userKey: string, p: Item): void {
  if (!userKey || p.Type !== 'Playlist') return;
  const list = [{ item: slim(p), t: Date.now() }, ...localRecentPlaylists(userKey).filter(r => r.item.Id !== p.Id)].slice(0, MAX);
  putList(keyOf(userKey), list, true);
  bumpRecents('playlists');
}

/**
 * Recently played playlists: Finch's own record merged with any server
 * DatePlayed entries, newest first. `all` (the current playlist list, when
 * loaded) refreshes names, counts and covers of the remembered entries, and
 * drops entries for playlists that no longer exist.
 */
export function mergeRecentPlaylists(
  userKey: string,
  server: Item[],
  all: Item[] | null,
  allComplete: boolean,
  deduced: { id: string; t: number }[] = [],
): Item[] {
  const byId = new Map((all ?? []).map(p => [p.Id, p]));
  const recs: Rec[] = [
    ...localRecentPlaylists(userKey),
    ...server.map(p => ({ item: p, t: Date.parse(p.UserData?.LastPlayedDate ?? '') || 0 })),
    // found in the play history via the playlist index (playlistIndex.ts);
    // only playlists in the current list can be shown (name, cover)
    ...deduced.flatMap(d => {
      const p = byId.get(d.id);
      return p ? [{ item: p, t: d.t }] : [];
    }),
  ].sort((a, b) => b.t - a.t);
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    if (seen.has(r.item.Id)) continue;
    seen.add(r.item.Id);
    const cur = byId.get(r.item.Id);
    if (!cur && all && allComplete) continue; // deleted on the server
    out.push(cur ?? r.item);
    if (out.length >= MAX) break;
  }
  return out;
}

// ---- cover repair: a playlist without its own Primary image shows its first
// track's album cover (one 1-item request per playlist, remembered per id).
const firstArt = new Map<string, Promise<Partial<Item> | null>>();

export async function repairPlaylistArt(api: Api, items: Item[], max = 24): Promise<Item[]> {
  const bare = items.filter(p => p.Type === 'Playlist' && !p.ImageTags?.Primary && !p.AlbumPrimaryImageTag).slice(0, max);
  if (!bare.length) return items;
  const fixes = new Map<string, Partial<Item>>();
  await Promise.all(
    bare.map(async p => {
      let f = firstArt.get(p.Id);
      if (!f) {
        f = api.playlistFirstTrack(p.Id).then(
          t => (t?.AlbumId && t.AlbumPrimaryImageTag ? { AlbumId: t.AlbumId, AlbumPrimaryImageTag: t.AlbumPrimaryImageTag } : null),
          () => {
            firstArt.delete(p.Id);
            return null;
          },
        );
        firstArt.set(p.Id, f);
      }
      const fix = await f;
      if (fix) fixes.set(p.Id, fix);
    }),
  );
  return fixes.size ? items.map(p => (fixes.has(p.Id) ? { ...p, ...fixes.get(p.Id) } : p)) : items;
}

// ---- change signal ----
export type RecentKind = 'tracks' | 'playlists';
const subs = new Set<(k: RecentKind) => void>();
export function onRecents(cb: (k: RecentKind) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export function bumpRecents(kind: RecentKind): void {
  for (const cb of [...subs]) cb(kind);
}

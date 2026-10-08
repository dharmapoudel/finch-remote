// Browse screens in finch-remote 1.2.1's layout (Home / Playlists / Albums /
// Library tabs of rails, See-all grids, the detail page), fed by Finch's own
// Jellyfin client. 1.4.3 adds the recents / favorites / genres rows (look from
// finch-remote; data from jellyfin.ts + recents.ts, cached in persist.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accentFromUrl } from '../accent';
import { artKey, cachedArt, HERO_PX, TILE_PX, useArtUrl } from '../art';
import type { Api } from '../demo';
import { artistLine, JellyfinError, shuffled, type Item, type Page } from '../jellyfin';
import {
  Artwork,
  Empty,
  GridCard,
  Icon,
  publishAmbient,
  Rail,
  RailSkeleton,
  Rise,
  SectionTitle,
  SeeAll,
  SkeletonGrid,
  SkeletonRow,
  Tile,
  TopBar,
  BackChip,
  HEADER_H,
  TrackRow,
  type MenuAction,
} from './components';
import { getList, putList } from '../persist';
import { deducePlaylists, notePlaylists, type Play } from '../playlistIndex';
import { mergeRecentPlaylists, notePlaylistPlayed, onRecents, repairPlaylistArt, type RecentKind } from '../recents';
import { useCore, useLite, useUi, type Lite, type NavFn } from './playback';

const RAIL_N = 5;
const PAGE_SIZE = 60;

function errText(err: unknown): string {
  if (err instanceof JellyfinError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// data hooks

// Small list loads (Home / tab rails, detail pages). 1.4.1: the last result
// of each is also kept on the device (persist.ts), so after an app restart
// the screen paints from it on the first frame; every mount still refreshes
// in the background and the fresh result replaces it.
const memo = new Map<string, unknown>();

/** Re-render counter that ticks when recents of `kind` change (recents.ts). */
function useRecentsTick(kind: RecentKind | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => (kind ? onRecents(k => k === kind && setN(x => x + 1)) : undefined), [kind]);
  return n;
}

function useLoad<T>(api: Api | null, baseKey: string, load: (a: Api) => Promise<T>, refreshOn?: RecentKind) {
  const { userKey } = useCore();
  const tick = useRecentsTick(refreshOn);
  const key = `${userKey}:${baseKey}`;
  const cached = () => (memo.get(key) as T | undefined) ?? (userKey ? getList<T>(key) : undefined) ?? null;
  const [state, setState] = useState<{ key: string; data: T | null }>(() => ({ key, data: cached() }));
  const data = state.key === key ? state.data : cached();
  const setData = (d: T) => setState({ key, data: d });
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!api) return;
    let live = true;
    setError(null);
    // 1.4.4: a reload caused by a track change (tick > 0) goes out at 'low'
    // link priority, behind the session poll, artwork and browsing
    load(tick > 0 ? api.withPriority('low') : api).then(
      d => {
        memo.set(key, d);
        if (userKey) putList(key, d);
        if (live) setData(d);
      },
      e => {
        if (live && !memo.has(key)) setError(errText(e));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, retry, tick]);
  return { data, error, retry: () => setRetry(r => r + 1) };
}

type Loader = (start: number, limit: number) => Promise<Page<Item>>;

/**
 * Paged library loader (Finch 1.3.1). 1.4.3: with a cacheKey, the first page
 * is kept in the persistent list cache, so a See-all grid paints its last
 * first page at once; the fresh first page then replaces it and paging goes
 * on from there.
 */
function usePaged(loader: Loader | null, cacheKey?: string) {
  const { userKey } = useCore();
  const fullKey = cacheKey && userKey ? `${userKey}:paged:${cacheKey}` : null;
  const [seed] = useState(() => (fullKey ? getList<Page<Item>>(fullKey) : undefined));
  const [items, setItems] = useState<Item[]>(seed?.Items ?? []);
  const [total, setTotal] = useState<number | null>(seed ? seed.TotalRecordCount : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // the cached first page is shown but not trusted: it is fetched again
  const fresh = useRef(!seed);

  const loadMore = useCallback(async () => {
    if (!loader || busy.current) return;
    const first = !fresh.current;
    if (!first && total !== null && items.length >= total) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await loader(first ? 0 : items.length, PAGE_SIZE);
      if (first || items.length === 0) {
        if (fullKey) putList(fullKey, page);
        fresh.current = true;
        setItems(page.Items);
      } else setItems(prev => [...prev, ...page.Items]);
      setTotal(page.TotalRecordCount ?? page.Items.length);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [loader, items.length, total, fullKey]);

  useEffect(() => {
    if (loader && (!fresh.current || (items.length === 0 && total === null)) && !busy.current && !error) void loadMore();
  }, [loader, items.length, total, loadMore, error]);

  return { items, total, loading: loading && fresh.current, error, loadMore, retry: () => setError(null) };
}

/** Publish a tab's art to the blurred backdrop behind the tab strip. */
function useTabAmbient(item: Item | null | undefined) {
  const { api } = useCore();
  const url = useArtUrl(api, item, TILE_PX);
  const own = url && item && cachedArt(item, TILE_PX) === url ? url : null;
  const accent = useAccentFill(own, item ? artKey(item, TILE_PX) : null);
  useEffect(() => {
    // wait for the accent so art and tint swap in together (no flicker)
    if (own && accent !== undefined) publishAmbient(own, accent);
  }, [own, accent]);
}

/** Accent fill sampled from an art URL: undefined while sampling, null when
 *  the art has no usable colour (or could not be sampled). */
function useAccentFill(url: string | null, key?: string | null): string | null | undefined {
  const [a, setA] = useState<{ url: string; fill: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    if (!url) return;
    void accentFromUrl(url, key).then(c => live && setA({ url, fill: c?.fill ?? null }));
    return () => {
      live = false;
    };
  }, [url, key]);
  if (!url) return null;
  return a && a.url === url ? a.fill : undefined;
}

// ---------------------------------------------------------------------------
// context-menu actions

function albumRef(t: Item): Item | null {
  if (!t.AlbumId) return null;
  return {
    Id: t.AlbumId,
    Name: t.Album ?? 'Album',
    Type: 'MusicAlbum',
    AlbumArtist: t.AlbumArtist,
    ImageTags: t.AlbumPrimaryImageTag ? { Primary: t.AlbumPrimaryImageTag } : undefined,
  };
}

function favAction(pb: Lite, item: Item): MenuAction {
  const fav = pb.favOf(item);
  return {
    // filled heart = it is a favorite now (tap removes), outline = add
    label: fav ? 'Remove from favorites' : 'Add to favorites',
    icon: fav ? 'heartFill' : 'heart',
    run: () => pb.act.setFavorite(item, !fav),
  };
}

export function trackActions(pb: Lite, nav: NavFn, t: Item): MenuAction[] {
  const album = albumRef(t);
  return [
    { label: 'Play next', icon: 'playNext', run: () => void pb.act.queueItems([t], true) },
    { label: 'Add to queue', icon: 'queueAdd', run: () => void pb.act.queueItems([t], false) },
    favAction(pb, t),
    { label: 'Start instant mix', icon: 'mix', run: () => void pb.act.instantMix(t) },
    ...(album ? [{ label: 'Go to album', icon: 'album' as const, run: () => nav({ name: 'detail', item: album }) }] : []),
  ];
}

/** Tracks of an album, playlist or (1.4.3) genre, in play order. */
function tracksOf(api: Api, item: Item): Promise<Item[]> {
  return item.Type === 'MusicGenre' ? api.genreTracks(item.Id).then(p => p.Items) : api.tracks(item);
}

/** Start a list; a playlist started from Finch goes on its recently played row. */
function playList(pb: Lite, from: Item, list: Item[], start = 0) {
  if (from.Type === 'Playlist') notePlaylistPlayed(pb.userKey, from);
  void pb.act.playItems(list, start);
}

function containerActions(pb: Lite, nav: NavFn, item: Item): MenuAction[] {
  const what = item.Type === 'Playlist' ? 'playlist' : item.Type === 'MusicGenre' ? 'genre' : 'album';
  const withTracks = (fn: (ts: Item[]) => void) => () => {
    if (!pb.api) return;
    tracksOf(pb.api, item).then(fn, err => pb.act.toast(errText(err)));
  };
  return [
    { label: `Play ${what}`, icon: 'play', run: withTracks(ts => playList(pb, item, ts, 0)) },
    { label: `Shuffle ${what}`, icon: 'shuffle', run: withTracks(ts => playList(pb, item, shuffled(ts), 0)) },
    { label: 'Play next', icon: 'playNext', run: withTracks(ts => void pb.act.queueItems(ts, true)) },
    { label: `Add ${what} to queue`, icon: 'queueAdd', run: withTracks(ts => void pb.act.queueItems(ts, false)) },
    { label: 'Start instant mix', icon: 'mix', run: () => void pb.act.instantMix(item) },
    ...(item.Type === 'MusicGenre' ? [] : [favAction(pb, item)]),
    {
      label: `Open ${what}`,
      icon: item.Type === 'Playlist' ? 'playlist' : item.Type === 'MusicGenre' ? 'genre' : 'album',
      run: () => nav({ name: 'detail', item }),
    },
  ];
}

function artistActions(pb: Lite, nav: NavFn, a: Item): MenuAction[] {
  return [
    { label: 'Start instant mix', icon: 'mix', run: () => void pb.act.instantMix(a) },
    { label: 'Open artist', icon: 'artist', run: () => nav({ name: 'detail', item: a }) },
  ];
}

function menuFor(pb: Lite, nav: NavFn, item: Item): MenuAction[] {
  if (item.Type === 'Audio') return trackActions(pb, nav, item);
  if (item.Type === 'MusicArtist') return artistActions(pb, nav, item);
  return containerActions(pb, nav, item);
}

function subtitleOf(item: Item): string | undefined {
  if (item.Type === 'Playlist') return item.ChildCount ? `${item.ChildCount} tracks` : undefined;
  if (item.Type === 'MusicArtist' || item.Type === 'MusicGenre') return undefined;
  return artistLine(item) || undefined;
}

function ScrollPage({ children, keyName }: { children: React.ReactNode; keyName: string }) {
  // Keep each tab's scroll position across tab switches.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const y = scrollTops.get(keyName) ?? 0;
    if (el && y) el.scrollTop = y;
    return () => {
      if (el) scrollTops.set(keyName, el.scrollTop);
    };
  }, [keyName]);
  return (
    <div ref={ref} className="h-full overflow-y-auto pt-3 pb-24">
      {children}
    </div>
  );
}
const scrollTops = new Map<string, number>();

/** Tap a track tile: the playing one opens Now Playing, others start playing. */
function playFrom(pb: Lite, list: Item[], i: number) {
  if (pb.nowId === list[i]?.Id) pb.act.openNowPlaying();
  else void pb.act.playItems(list, i);
}

// ---------------------------------------------------------------------------
// tabs

/** A row with nothing in it yet: its title and one quiet line (1.4.3). */
function RowNote({ title, text }: { title: string; text: string }) {
  return (
    <section className="mb-7 shrink-0">
      <SectionTitle title={title} />
      <div className="px-5 text-lg text-white/35">{text}</div>
    </section>
  );
}

/** Rail of track tiles: tap plays from that track (the playing one opens Now Playing). */
function TrackRail({ title, list, onSeeAll }: { title: string; list: Item[]; onSeeAll?: () => void }) {
  const pb = useLite();
  const { nav, openMenu } = useUi();
  return (
    <Rail title={title} onSeeAll={onSeeAll}>
      {list.slice(0, RAIL_N).map((t, i) => (
        <Rise key={t.Id} i={i}>
          <Tile
            title={t.Name}
            subtitle={artistLine(t)}
            item={t}
            active={pb.nowId === t.Id}
            onClick={() => playFrom(pb, list, i)}
            onMenu={() => openMenu(t.Name, trackActions(pb, nav, t))}
          />
        </Rise>
      ))}
    </Rail>
  );
}

/**
 * One row of a tab: skeleton while its first load is out, the rail when it
 * has items, a quiet line when it is empty (or failed while other rows
 * loaded), so a row never looks broken.
 */
function Row({
  title,
  data,
  error,
  empty,
  children,
}: {
  title: string;
  data: Item[] | null | undefined;
  error?: string | null;
  empty: string;
  children: (list: Item[]) => React.ReactNode;
}) {
  if (!data) return error ? <RowNote title={title} text={`Could not load: ${error}`} /> : <RailSkeleton />;
  if (!data.length) return <RowNote title={title} text={empty} />;
  return <Rise>{children(data)}</Rise>;
}

export function Home() {
  const pb = useLite();
  const { nav } = useUi();
  const recent = useLoad(pb.api, 'home:recent', a => a.recentTracks(0, RAIL_N + 1), 'tracks');
  const favs = useLoad(pb.api, 'home:favs', a => a.favoriteTracks(0, RAIL_N + 1));
  const added = useLoad(pb.api, 'home:added', a => a.albums(0, 4, 'DateCreated'));
  useTabAmbient(recent.data?.Items[0] ?? favs.data?.Items[0] ?? added.data?.Items[0]);
  const err = recent.error ?? favs.error ?? added.error;
  const none = !recent.data && !favs.data && !added.data;

  return (
    <ScrollPage keyName="home">
      {err && none ? (
        <Empty text={`Could not reach Jellyfin: ${err}`} onRetry={() => (recent.retry(), favs.retry(), added.retry())} />
      ) : (
        <>
          <Row title="Recent tracks" data={recent.data?.Items} error={recent.error} empty="Songs you play show up here.">
            {list => (
              <TrackRail
                title="Recent tracks"
                list={list}
                onSeeAll={list.length > RAIL_N ? () => nav({ name: 'recenttracks' }) : undefined}
              />
            )}
          </Row>
          <Row
            title="Favorites"
            data={favs.data?.Items}
            error={favs.error}
            empty="No favorite tracks yet. Hold preset 4 while a song plays to add one."
          >
            {list => (
              <TrackRail title="Favorites" list={list} onSeeAll={list.length > RAIL_N ? () => nav({ name: 'favorites' }) : undefined} />
            )}
          </Row>
          {added.data ? (
            added.data.Items.length ? (
              <Rise>
                <section className="mb-7 shrink-0">
                  <SectionTitle
                    title="Recently added"
                    onSeeAll={added.data.TotalRecordCount > added.data.Items.length ? () => nav({ name: 'albumlist', kind: 'recent' }) : undefined}
                  />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-4">
                    {added.data.Items.map((a, i) => (
                      <Rise key={a.Id} i={i}>
                        <button
                          type="button"
                          data-focusable
                          onClick={() => nav({ name: 'detail', item: a })}
                          className="flex w-full items-center gap-3 rounded-xl p-1 text-left active:opacity-80"
                        >
                          <Artwork item={a} size={56} px={96} rounded="rounded-lg" label={a.Name} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-lg font-medium text-white">{a.Name}</span>
                            <span className="block truncate text-base text-white/50">
                              {a.ChildCount ? `${a.ChildCount} Tracks | ` : ''}
                              {a.AlbumArtist ?? ''}
                            </span>
                          </span>
                        </button>
                      </Rise>
                    ))}
                  </div>
                </section>
              </Rise>
            ) : (
              <RowNote title="Recently added" text="Your library looks empty. Add music to Jellyfin and it shows up here." />
            )
          ) : added.error ? null : (
            <RailSkeleton />
          )}
        </>
      )}
    </ScrollPage>
  );
}

function ItemRail({
  title,
  items,
  onSeeAll,
}: {
  title: string;
  items: Item[];
  onSeeAll?: () => void;
}) {
  const pb = useLite();
  const { nav, openMenu } = useUi();
  return (
    <Rail title={title} onSeeAll={onSeeAll}>
      {items.slice(0, RAIL_N).map((it, i) => (
        <Rise key={it.Id} i={i}>
          <Tile
            title={it.Name}
            subtitle={subtitleOf(it)}
            item={it}
            round={it.Type === 'MusicArtist'}
            onClick={() => nav({ name: 'detail', item: it })}
            onMenu={() => openMenu(it.Name, menuFor(pb, nav, it))}
          />
        </Rise>
      ))}
    </Rail>
  );
}

/** All playlists (one bounded load, covers repaired) — shared by the tab and its See-all pages. */
function usePlaylists(api: Api | null) {
  return useLoad(api, 'playlists:all', a =>
    a.playlists(0, 200).then(pg => repairPlaylistArt(a, pg.Items).then(Items => ({ ...pg, Items }))),
  );
}

type PlayedData = { server: Item[]; plays: Play[] };

/**
 * Recently played playlists: Finch's own record of playlists it started,
 * server DatePlayed (rare), and playlists found in the last 100 track plays
 * through the playlist index (any player). Reloads when the playing track
 * changes; re-merges when the record or the index changes.
 */
function useRecentPlaylists(api: Api | null, all: Page<Item> | null) {
  const { userKey } = useCore();
  const tick = useRecentsTick('playlists');
  const played = useLoad<PlayedData>(
    api,
    'playlists:played',
    async a => {
      const [server, recent] = await Promise.all([
        a.playedPlaylists(30).catch(() => [] as Item[]),
        a.recentPlays(0, 100).catch(() => null),
      ]);
      const plays = (recent?.Items ?? []).flatMap(t => {
        const at = Date.parse(t.UserData?.LastPlayedDate ?? '');
        return Number.isFinite(at) ? [{ Id: t.Id, AlbumId: t.AlbumId, t: at }] : [];
      });
      return { server, plays };
    },
    'tracks',
  );
  // the tab's list flags playlists whose contents changed (throttled re-read)
  useEffect(() => {
    if (api && all) notePlaylists(api, userKey, all.Items);
  }, [api, userKey, all]);
  return useMemo(() => {
    const d = played.data;
    const deduced = d && Array.isArray(d.plays) ? deducePlaylists(userKey, d.plays) : [];
    const server = d && Array.isArray(d.server) ? d.server : [];
    return mergeRecentPlaylists(userKey, server, all?.Items ?? null, !!all && all.Items.length >= all.TotalRecordCount, deduced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey, played.data, all, tick]);
}

export function Playlists() {
  const pb = useLite();
  const { nav } = useUi();
  const all = usePlaylists(pb.api);
  const list = all.data?.Items ?? [];
  const favs = list.filter(p => pb.favOf(p));
  const recent = useRecentPlaylists(pb.api, all.data);
  useTabAmbient(recent[0] ?? favs[0] ?? list[0]);
  return (
    <ScrollPage keyName="playlists">
      {all.error && !all.data ? (
        <Empty text={`Could not load playlists: ${all.error}`} onRetry={all.retry} />
      ) : !all.data ? (
        <>
          <RailSkeleton />
          <RailSkeleton />
        </>
      ) : list.length === 0 ? (
        <Empty text="No playlists yet. Make one in Jellyfin and it shows up here." />
      ) : (
        <>
          <Row title="Recently played" data={recent} empty="Playlists you start from Finch show up here.">
            {items => (
              <ItemRail
                title="Recently played"
                items={items}
                onSeeAll={items.length > RAIL_N ? () => nav({ name: 'playlistlist', kind: 'recent' }) : undefined}
              />
            )}
          </Row>
          <Row title="Favorites" data={favs} empty="No favorite playlists yet.">
            {items => (
              <ItemRail
                title="Favorites"
                items={items}
                onSeeAll={items.length > RAIL_N ? () => nav({ name: 'playlistlist', kind: 'favorites' }) : undefined}
              />
            )}
          </Row>
          <ItemRail
            title="All playlists"
            items={list}
            onSeeAll={list.length > RAIL_N ? () => nav({ name: 'playlistlist', kind: 'all' }) : undefined}
          />
        </>
      )}
    </ScrollPage>
  );
}

export function Albums() {
  const pb = useLite();
  const { nav } = useUi();
  const recent = useLoad(pb.api, 'albums:played', a => a.recentAlbums(30), 'tracks');
  const favs = useLoad(pb.api, 'albums:favs', a => a.favoriteAlbums(0, RAIL_N + 1));
  const all = useLoad(pb.api, 'albums:all', a => a.albums(0, RAIL_N + 1, 'SortName'));
  useTabAmbient(recent.data?.Items[0] ?? favs.data?.Items[0] ?? all.data?.Items[0]);
  const err = recent.error ?? favs.error ?? all.error;
  return (
    <ScrollPage keyName="albums">
      {err && !recent.data && !favs.data && !all.data ? (
        <Empty text={`Could not load albums: ${err}`} onRetry={() => (recent.retry(), favs.retry(), all.retry())} />
      ) : (
        <>
          <Row title="Recent albums" data={recent.data?.Items} error={recent.error} empty="Albums you play show up here.">
            {items => (
              <ItemRail
                title="Recent albums"
                items={items}
                onSeeAll={items.length > RAIL_N ? () => nav({ name: 'albumlist', kind: 'played' }) : undefined}
              />
            )}
          </Row>
          <Row title="Favorites" data={favs.data?.Items} error={favs.error} empty="No favorite albums yet.">
            {items => (
              <ItemRail
                title="Favorites"
                items={items}
                onSeeAll={(favs.data?.TotalRecordCount ?? 0) > RAIL_N ? () => nav({ name: 'albumlist', kind: 'favorites' }) : undefined}
              />
            )}
          </Row>
          <Row title="All albums" data={all.data?.Items} error={all.error} empty="No albums yet.">
            {items => (
              <ItemRail
                title="All albums"
                items={items}
                onSeeAll={(all.data?.TotalRecordCount ?? 0) > RAIL_N ? () => nav({ name: 'albumlist', kind: 'all' }) : undefined}
              />
            )}
          </Row>
        </>
      )}
    </ScrollPage>
  );
}

export function Library() {
  const pb = useLite();
  const { nav } = useUi();
  const artists = useLoad(pb.api, 'lib:artists', a => a.artists(0, RAIL_N + 1));
  const genres = useLoad(pb.api, 'lib:genres', a => a.genres(0, RAIL_N + 1));
  useTabAmbient(artists.data?.Items[0]);
  return (
    <ScrollPage keyName="library">
      {artists.error && genres.error && !artists.data && !genres.data ? (
        <Empty text={`Could not load the library: ${artists.error}`} onRetry={() => (artists.retry(), genres.retry())} />
      ) : (
        <>
          <Row title="Artists" data={artists.data?.Items} error={artists.error} empty="No artists yet.">
            {items => (
              <ItemRail
                title="Artists"
                items={items}
                onSeeAll={(artists.data?.TotalRecordCount ?? 0) > RAIL_N ? () => nav({ name: 'artists' }) : undefined}
              />
            )}
          </Row>
          <Row title="Genres" data={genres.data?.Items} error={genres.error} empty="No genres yet. Jellyfin reads them from your music's tags.">
            {items => (
              <ItemRail
                title="Genres"
                items={items}
                onSeeAll={(genres.data?.TotalRecordCount ?? 0) > RAIL_N ? () => nav({ name: 'genres' }) : undefined}
              />
            )}
          </Row>
        </>
      )}
    </ScrollPage>
  );
}

// ---------------------------------------------------------------------------
// See-all lists

function PagedGrid({ title, loader, cacheKey }: { title: string; loader: Loader | null; cacheKey: string }) {
  const pb = useLite();
  const { nav, back, openMenu } = useUi();
  const list = usePaged(loader, cacheKey);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 500) void list.loadMore();
  };
  return (
    <div className="flex h-full flex-col" data-key={cacheKey}>
      <TopBar title={title} onBack={back} right={list.total != null ? <span className="text-base text-white/45">{list.total}</span> : null} />
      <div onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 pt-1.5 pb-24">
        {list.error && !list.items.length ? (
          <Empty text={`Could not load: ${list.error}`} onRetry={list.retry} />
        ) : list.items.length === 0 ? (
          list.loading || list.total === null ? <SkeletonGrid /> : <Empty text="Nothing here yet." />
        ) : (
          <>
            <div className="grid grid-cols-4 gap-x-4 gap-y-5">
              {list.items.map(it => (
                <GridCard
                  key={it.Id}
                  item={it}
                  title={it.Name}
                  subtitle={subtitleOf(it)}
                  round={it.Type === 'MusicArtist'}
                  onClick={() => nav({ name: 'detail', item: it })}
                  onMenu={() => openMenu(it.Name, menuFor(pb, nav, it))}
                />
              ))}
            </div>
            {list.loading ? <p className="mt-4 text-center text-sm text-white/40">Loading more…</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

const ALBUM_LIST_TITLE = { recent: 'Recently added', all: 'All albums', played: 'Recent albums', favorites: 'Favorite albums' } as const;

export function AlbumList({ kind }: { kind: 'recent' | 'all' | 'played' | 'favorites' }) {
  const { api } = useCore();
  const loader: Loader | null = !api
    ? null
    : kind === 'played'
      ? // bounded list (derived from play history), one "page"
        s => (s === 0 ? api.recentAlbums(60) : Promise.resolve({ Items: [], TotalRecordCount: 0 }))
      : kind === 'favorites'
        ? (s, l) => api.favoriteAlbums(s, l)
        : (s, l) => api.albums(s, l, kind === 'recent' ? 'DateCreated' : 'SortName');
  return <PagedGrid key={kind} cacheKey={`albums:${kind}`} title={ALBUM_LIST_TITLE[kind]} loader={useStable(loader, kind)} />;
}

export function ArtistList() {
  const { api } = useCore();
  const loader: Loader | null = api ? (s, l) => api.artists(s, l) : null;
  return <PagedGrid cacheKey="artists" title="Artists" loader={useStable(loader, 'artists')} />;
}

export function GenreList() {
  const { api } = useCore();
  const loader: Loader | null = api ? (s, l) => api.genres(s, l) : null;
  return <PagedGrid cacheKey="genres" title="Genres" loader={useStable(loader, 'genres')} />;
}

export function GenreAlbums({ item }: { item: Item }) {
  const { api } = useCore();
  const loader: Loader | null = api ? (s, l) => api.genreAlbums(item.Id, s, l) : null;
  return <PagedGrid cacheKey={`genre-albums:${item.Id}`} title={`${item.Name} albums`} loader={useStable(loader, `ga:${item.Id}`)} />;
}

const PLAYLIST_LIST_TITLE = { all: 'All playlists', favorites: 'Favorite playlists', recent: 'Recently played' } as const;

export function PlaylistList({ kind }: { kind: 'favorites' | 'all' | 'recent' }) {
  const pb = useLite();
  const { nav, back, openMenu } = useUi();
  const all = usePlaylists(pb.api);
  const recent = useRecentPlaylists(pb.api, all.data);
  const list = kind === 'recent' ? recent : (all.data?.Items ?? []).filter(p => kind === 'all' || pb.favOf(p));
  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={PLAYLIST_LIST_TITLE[kind]}
        onBack={back}
        right={list.length && (kind === 'recent' || all.data) ? <span className="text-base text-white/45">{list.length}</span> : null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1.5 pb-24">
        {all.error && !all.data && kind !== 'recent' ? (
          <Empty text={`Could not load playlists: ${all.error}`} onRetry={all.retry} />
        ) : !all.data && kind !== 'recent' ? (
          <SkeletonGrid />
        ) : list.length === 0 ? (
          <Empty text={kind === 'recent' ? 'Playlists you start from Finch show up here.' : 'No playlists here yet.'} />
        ) : (
          <div className="grid grid-cols-4 gap-x-4 gap-y-5">
            {list.map(p => (
              <GridCard
                key={p.Id}
                item={p}
                title={p.Name}
                subtitle={subtitleOf(p)}
                onClick={() => nav({ name: 'detail', item: p })}
                onMenu={() => openMenu(p.Name, menuFor(pb, nav, p))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Paged list of track rows (Favorite tracks, Recent tracks). */
function TrackList({ title, loader, cacheKey, empty }: { title: string; loader: Loader | null; cacheKey: string; empty: string }) {
  const pb = useLite();
  const { nav, back, openMenu } = useUi();
  const list = usePaged(loader, cacheKey);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 500) void list.loadMore();
  };
  return (
    <div className="flex h-full flex-col">
      <TopBar title={title} onBack={back} />
      <div onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 pt-0.5 pb-24">
        {list.error && !list.items.length ? (
          <Empty text={`Could not load: ${list.error}`} onRetry={list.retry} />
        ) : list.items.length === 0 ? (
          list.total === 0 ? (
            <Empty text={empty} />
          ) : (
            [0, 1, 2, 3, 4].map(i => <SkeletonRow key={i} />)
          )
        ) : (
          list.items.map((t, i) => (
            <Rise key={`${t.Id}-${i}`} i={Math.min(i, 8)}>
              <TrackRow
                track={t}
                onPlay={() => playFrom(pb, list.items, i)}
                onToggle={() => (pb.nowId === t.Id ? pb.act.toggle() : void pb.act.playItems(list.items, i))}
                onMenu={() => openMenu(t.Name, trackActions(pb, nav, t))}
              />
            </Rise>
          ))
        )}
      </div>
    </div>
  );
}

export function FavoriteTracks() {
  const { api } = useCore();
  const loader = useStable(api ? (s: number, l: number) => api.favoriteTracks(s, l) : null, 'favs');
  return (
    <TrackList title="Favorite tracks" cacheKey="favs" loader={loader} empty="No favorite tracks yet. Hold preset 4 while a song plays to add one." />
  );
}

export function RecentTracks() {
  const { api } = useCore();
  const loader = useStable(api ? (s: number, l: number) => api.recentTracks(s, l) : null, 'recent');
  return <TrackList title="Recent tracks" cacheKey="recent" loader={loader} empty="Songs you play show up here." />;
}

/** A loader that only changes identity when `key` (or the api) changes. */
function useStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; v: T; has: boolean }>({ key, v: value, has: !!value });
  if (ref.current.key !== key || (!ref.current.has && value)) ref.current = { key, v: value, has: !!value };
  return ref.current.v;
}

// ---------------------------------------------------------------------------
// detail

type DetailData = {
  tracks: Item[] | null;
  albums: Item[] | null;
  error: string | null;
  /** genres (1.4.3): server totals, the page shows the first albums / tracks */
  albumTotal?: number;
  trackTotal?: number;
};
type GenreCache = { a: Item[]; t: Item[]; at: number; tt: number };
const GENRE_ALBUMS_SHOWN = 8;

function RoundBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-focusable
      aria-label={label}
      title={label}
      disabled={disabled}
      data-sel="dot"
      onClick={onClick}
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/10 active:bg-white/20 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

const TYPE_LABEL: Record<string, string> = { MusicAlbum: 'Album', Playlist: 'Playlist', MusicArtist: 'Artist', MusicGenre: 'Genre' };

export function Detail({ item }: { item: Item }) {
  const pb = useLite();
  const { nav, back, openMenu } = useUi();
  const isArtist = item.Type === 'MusicArtist';
  const isGenre = item.Type === 'MusicGenre';
  // 1.4.1: the last track / album list of this page comes from the device
  // cache first (instant paint), then the fresh one replaces it.
  const cacheKey = `${pb.userKey}:detail:${item.Id}`;
  const fromCache = (): DetailData => {
    const none = { tracks: null, albums: null, error: null };
    if (!pb.userKey) return none;
    if (isGenre) {
      const g = getList<GenreCache>(cacheKey);
      return g ? { tracks: g.t, albums: g.a, error: null, albumTotal: g.at, trackTotal: g.tt } : none;
    }
    const c = getList<Item[]>(cacheKey);
    return c ? { tracks: isArtist ? null : c, albums: isArtist ? c : null, error: null } : none;
  };
  const [d, setD] = useState<DetailData>(fromCache);
  const [retry, setRetry] = useState(0);
  const api = pb.api;

  useEffect(() => {
    if (!api) return;
    let live = true;
    const p: Promise<DetailData> = isGenre
      ? Promise.all([api.genreAlbums(item.Id, 0, GENRE_ALBUMS_SHOWN), api.genreTracks(item.Id)]).then(([al, tr]) => ({
          tracks: tr.Items,
          albums: al.Items,
          error: null,
          albumTotal: al.TotalRecordCount,
          trackTotal: tr.TotalRecordCount,
        }))
      : isArtist
        ? api.artistAlbums(item.Id).then(pg => ({ tracks: null, albums: pg.Items, error: null }))
        : api.tracks(item).then(ts => ({ tracks: ts, albums: null, error: null }));
    p.then(
      v => {
        if (pb.userKey) {
          if (isGenre) putList(cacheKey, { a: v.albums ?? [], t: v.tracks ?? [], at: v.albumTotal ?? 0, tt: v.trackTotal ?? 0 } satisfies GenreCache);
          else putList(cacheKey, isArtist ? v.albums : v.tracks);
        }
        if (live) setD(v);
      },
      e => live && setD(prev => (prev.tracks || prev.albums ? prev : { tracks: null, albums: null, error: errText(e) })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, item, isArtist, retry]);

  const headerUrl = useArtUrl(api, item, HERO_PX);
  const accentState = useAccentFill(headerUrl && cachedArt(item, HERO_PX) === headerUrl ? headerUrl : null, artKey(item, HERO_PX));
  const accent = accentState ?? null;
  useEffect(() => {
    if (headerUrl && accentState !== undefined) publishAmbient(headerUrl, accentState);
  }, [headerUrl, accentState]);

  const tracks = d.tracks;
  const loading = !d.error && (isArtist ? d.albums === null : tracks === null);
  const count = isArtist ? d.albums?.length : tracks?.length;
  const countLabel = isGenre
    ? `${d.albumTotal ?? '…'} album${d.albumTotal === 1 ? '' : 's'} · ${d.trackTotal ?? '…'} track${d.trackTotal === 1 ? '' : 's'}`
    : isArtist
      ? `${count ?? '…'} album${count === 1 ? '' : 's'}`
      : `${count ?? item.ChildCount ?? '…'} track${count === 1 ? '' : 's'}`;
  // a genre's track list is capped; its length is not the genre's length
  const showMinutes = !!tracks?.length && !isGenre;
  const totalMs = (tracks ?? []).reduce((s, t) => s + (t.RunTimeTicks ?? 0) / 10_000, 0);
  const fav = pb.favOf(item);

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {/* 1.4.4: no tab strip here and no second backdrop layer (the App
            backdrop already shows this page's art, published above, so the
            top of the screen is one continuous surface). One slim 36 px line:
            back chevron + what this page is; the title lives in the hero. */}
        <div className="relative z-10 flex items-center gap-1 pr-4 pl-2" style={{ height: HEADER_H }}>
          <BackChip onBack={back} />
          <span className="text-xs font-semibold tracking-[0.22em] text-white/70 uppercase [text-shadow:0_1px_4px_rgba(0,0,0,0.6)]">
            {TYPE_LABEL[item.Type ?? ''] ?? ''}
          </span>
        </div>
        <div className="relative px-5 pt-1 pb-24">
          <Rise>
            <div className="mb-6 flex items-end gap-5">
              <div className="shrink-0 shadow-2xl shadow-black/60">
                <Artwork item={item} size={160} px={HERO_PX} rounded="rounded-3xl" round={isArtist} label={item.Name} />
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="line-clamp-2 text-3xl leading-tight font-bold tracking-tight">{item.Name}</div>
                <div className="mt-1 truncate text-xl text-white/60">
                  {!isArtist && item.Type === 'MusicAlbum' && item.AlbumArtist ? `${item.AlbumArtist} · ` : ''}
                  {countLabel}
                  {showMinutes ? ` · ${Math.round(totalMs / 60000)} min` : ''}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  {isArtist ? (
                    <button
                      type="button"
                      data-focusable
                      data-focus-default
                      onClick={() => void pb.act.instantMix(item)}
                      style={accent ? { backgroundColor: accent } : undefined}
                      className={`flex h-16 shrink-0 items-center gap-2 rounded-full px-7 text-2xl font-bold text-black active:brightness-90 ${accent ? '' : 'bg-leaf'}`}
                    >
                      <Icon name="mix" size={26} /> Instant mix
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-focusable
                        data-focus-default
                        disabled={!tracks?.length}
                        onClick={() => tracks && playList(pb, item, tracks, 0)}
                        style={accent ? { backgroundColor: accent } : undefined}
                        className={`flex h-16 shrink-0 items-center gap-2 rounded-full px-7 text-2xl font-bold text-black active:brightness-90 disabled:opacity-40 ${
                          accent ? '' : 'bg-leaf'
                        }`}
                      >
                        <Icon name="play" size={26} /> Play
                      </button>
                      <RoundBtn label="Shuffle play" disabled={!tracks?.length} onClick={() => tracks && playList(pb, item, shuffled(tracks), 0)}>
                        <Icon name="shuffle" size={26} />
                      </RoundBtn>
                      <RoundBtn label="Play next" disabled={!tracks?.length} onClick={() => tracks && void pb.act.queueItems(tracks, true)}>
                        <Icon name="playNext" size={26} />
                      </RoundBtn>
                      {/* Finch 1.3.1's labelled Instant mix action, same behaviour */}
                      <button
                        type="button"
                        data-focusable
                        aria-label="Instant mix"
                        onClick={() => void pb.act.instantMix(item)}
                        className="flex h-16 shrink-0 items-center gap-2 rounded-full bg-white/10 px-5 text-lg font-semibold active:bg-white/20"
                      >
                        <Icon name="mix" size={24} /> Mix
                      </button>
                    </>
                  )}
                  {isGenre ? null : (
                    <RoundBtn label={fav ? 'Remove from favorites' : 'Add to favorites'} onClick={() => pb.act.setFavorite(item, !fav)}>
                      <Icon name={fav ? 'heartFill' : 'heart'} size={26} className={fav ? 'text-leaf' : ''} />
                    </RoundBtn>
                  )}
                </div>
              </div>
            </div>
          </Rise>

          {d.error ? (
            <Empty text={`Could not load: ${d.error}`} onRetry={() => setRetry(r => r + 1)} />
          ) : loading ? (
            [0, 1, 2, 3].map(i => <SkeletonRow key={i} />)
          ) : isGenre && d.albums?.length ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-[0.22em] text-white/80 uppercase">Albums</h2>
                {(d.albumTotal ?? 0) > d.albums.length ? (
                  <SeeAll onClick={() => nav({ name: 'genrealbums', item })} />
                ) : null}
              </div>
              <div className="mb-7 grid grid-cols-4 gap-x-4 gap-y-6">
                {d.albums.map((a, i) => (
                  <Rise key={a.Id} i={i}>
                    <GridCard
                      item={a}
                      title={a.Name}
                      subtitle={a.AlbumArtist}
                      onClick={() => nav({ name: 'detail', item: a })}
                      onMenu={() => openMenu(a.Name, containerActions(pb, nav, a))}
                    />
                  </Rise>
                ))}
              </div>
              <h2 className="mb-2 text-xs font-semibold tracking-[0.22em] text-white/80 uppercase">
                Tracks{(d.trackTotal ?? 0) > (tracks?.length ?? 0) ? ` · first ${tracks?.length}` : ''}
              </h2>
              {(tracks ?? []).map((t, i) => (
                <Rise key={`${t.Id}-${i}`} i={Math.min(i, 8)}>
                  <TrackRow
                    track={t}
                    onPlay={() => playFrom(pb, tracks!, i)}
                    onToggle={() => (pb.nowId === t.Id ? pb.act.toggle() : void pb.act.playItems(tracks!, i))}
                    onMenu={() => openMenu(t.Name, trackActions(pb, nav, t))}
                  />
                </Rise>
              ))}
            </>
          ) : isArtist ? (
            d.albums!.length ? (
              <>
                <h2 className="mb-3 text-xs font-semibold tracking-[0.22em] text-white/80 uppercase">Albums</h2>
                <div className="grid grid-cols-4 gap-x-4 gap-y-6">
                  {d.albums!.map((a, i) => (
                    <Rise key={a.Id} i={i}>
                      <GridCard
                        item={a}
                        title={a.Name}
                        subtitle={a.ProductionYear ? String(a.ProductionYear) : undefined}
                        onClick={() => nav({ name: 'detail', item: a })}
                        onMenu={() => openMenu(a.Name, containerActions(pb, nav, a))}
                      />
                    </Rise>
                  ))}
                </div>
              </>
            ) : (
              <Empty text="No albums for this artist." />
            )
          ) : tracks!.length === 0 ? (
            <Empty text="Nothing here yet." />
          ) : (
            <div className="flex flex-col">
              {tracks!.map((t, i) => {
                const isAlbum = item.Type === 'MusicAlbum';
                const sub = isAlbum
                  ? (t.Artists?.join(', ') ?? '') !== (item.AlbumArtist ?? '')
                    ? artistLine(t)
                    : ''
                  : undefined;
                return (
                  <Rise key={`${t.Id}-${i}`} i={i}>
                    <TrackRow
                      track={t}
                      showArt={!isAlbum}
                      indexLabel={isAlbum ? String(t.IndexNumber ?? i + 1) : undefined}
                      subtitle={sub}
                      onPlay={() => (pb.nowId === t.Id ? pb.act.openNowPlaying() : playList(pb, item, tracks!, i))}
                      onToggle={() => (pb.nowId === t.Id ? pb.act.toggle() : playList(pb, item, tracks!, i))}
                      onMenu={() => openMenu(t.Name, trackActions(pb, nav, t))}
                    />
                  </Rise>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

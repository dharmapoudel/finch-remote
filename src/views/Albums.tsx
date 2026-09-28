import { useMemo } from 'react';
import { albumActions } from '../actions';
import { AmbientArt, Empty, GridCard, Rail, Tile, TopBar, useArt, useArtAccent } from '../components';
import { type Album, type Track } from '../jellyfin';
import type { ViewProps } from '../nav';
import {
  ListError,
  RAIL_N,
  RailSkeleton,
  SkeletonGrid,
  useBounded,
  usePagedList,
  useScrollKeepAlive,
} from './listkit';

// Recently-played albums: Jellyfin reports recent tracks, so dedupe them on
// albumId (order = most recent first).
function albumsFromTracks(tracks: Track[]): Album[] {
  const seen = new Set<string>();
  const out: Album[] = [];
  for (const t of tracks) {
    if (!t.albumId || seen.has(t.albumId)) continue;
    seen.add(t.albumId);
    out.push({
      id: t.albumId,
      name: t.album || 'Unknown album',
      artist: t.artist,
      year: null,
      songCount: 0,
      // Album art tag can be missing on older servers even when the track
      // carries its own art — fall back so the tile isn't a placeholder.
      imageTag: t.albumImageTag ?? t.imageTag,
      isFavorite: false,
    });
  }
  return out;
}

// Albums tab: Favorite albums rail, Recently played albums rail, then an
// All albums rail with See all — all in the Recent-tracks rail design language.
export default function AlbumsHome({ jf, nav, openMenu }: ViewProps) {
  const art = useArt();
  const favs = useBounded<Album>('albums:favs', () => jf.favoriteAlbums(RAIL_N + 1));
  const recentTracks = useBounded<Track>('albums:recent-tracks', () => jf.recentlyPlayedTracks(60));
  const albums = usePagedList<Album>('lib:albums', (s, l) => jf.albums(s, l));
  const recentAlbums = useMemo(
    () => (recentTracks.data ? albumsFromTracks(recentTracks.data) : null),
    [recentTracks.data],
  );
  const scroll = useScrollKeepAlive('albums', !!albums.data || !!favs.data || !!recentAlbums);
  const err = favs.error ?? recentTracks.error ?? albums.error;
  const rawErr = favs.error ? favs.rawError : recentTracks.error ? recentTracks.rawError : albums.rawError;

  const retryAll = () => {
    favs.retry();
    recentTracks.retry();
    albums.retry();
  };

  // Blurred backdrop behind the transparent tab strip: first favorite
  // album, else the most recently played album, else the first album.
  // Fixed so it paints behind the tabs.
  const ambientAlbum = favs.data?.[0] ?? recentAlbums?.[0] ?? albums.data?.[0] ?? null;
  const ambientSrc = ambientAlbum && art ? (art.albumArt(ambientAlbum, 256) ?? null) : null;
  const accent = useArtAccent(ambientSrc);

  const albumTile = (a: Album) => (
    <Tile
      fluid
      key={a.id}
      size={120}
      title={a.name}
      subtitle={a.artist || undefined}
      art={art?.albumArt(a) ?? null}
      onClick={() => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name })}
      onMenu={() => openMenu(a.name, albumActions(a, jf, nav))}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <AmbientArt src={ambientSrc} accent={accent} height={340} fixed />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto py-3">
        {err ? (
          <ListError error={err} rawError={rawErr} onRetry={retryAll} what="albums" nav={nav} />
        ) : (
          <>
            {favs.data ? (
              favs.data.length > 0 ? (
                <Rail
                  title="Favorite albums"
                  onSeeAll={
                    favs.data.length > RAIL_N
                      ? () => nav({ name: 'albumlist', kind: 'favorites' })
                      : undefined
                  }
                >
                  {favs.data.slice(0, RAIL_N).map(albumTile)}
                </Rail>
              ) : null
            ) : (
              <RailSkeleton />
            )}
            {recentAlbums ? (
              recentAlbums.length > 0 ? (
                <Rail
                  title="Recent albums"
                  onSeeAll={
                    recentAlbums.length > RAIL_N
                      ? () => nav({ name: 'albumlist', kind: 'recent' })
                      : undefined
                  }
                >
                  {recentAlbums.slice(0, RAIL_N).map(albumTile)}
                </Rail>
              ) : null
            ) : (
              <RailSkeleton />
            )}
            {albums.data ? (
              albums.data.length > 0 ? (
                <Rail
                  title="All albums"
                  onSeeAll={
                    albums.data.length > RAIL_N
                      ? () => nav({ name: 'albumlist', kind: 'all' })
                      : undefined
                  }
                >
                  {albums.data.slice(0, RAIL_N).map(albumTile)}
                </Rail>
              ) : (
                <Empty text="No albums found." />
              )
            ) : (
              <RailSkeleton />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// See-all destination for the Favorite albums / Recently played albums rails.
function BoundedAlbumListView({
  jf,
  nav,
  back,
  openMenu,
  kind,
}: ViewProps & { kind: 'favorites' | 'recent' }) {
  const art = useArt();
  const title = kind === 'favorites' ? 'Favorite albums' : 'Recent albums';
  const list = useBounded<Album>(
    `albums:${kind}:all`,
    () =>
      kind === 'favorites'
        ? jf.favoriteAlbums(200)
        : jf.recentlyPlayedTracks(200).then(albumsFromTracks),
  );
  const scroll = useScrollKeepAlive(`albumlist:${kind}`, !!list.data);
  const { data, error, rawError, retry } = list;

  return (
    <div className="flex h-full flex-col">
      <TopBar title={title} onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what={title.toLowerCase()} nav={nav} />
        ) : data ? (
          <div className="grid grid-cols-3 gap-x-4 gap-y-6">
            {data.map(a => (
              <GridCard
                key={a.id}
                title={a.name}
                subtitle={a.artist}
                art={art?.albumArt(a) ?? null}
                onClick={() => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name })}
                onMenu={() => openMenu(a.name, albumActions(a, jf, nav))}
              />
            ))}
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </div>
    </div>
  );
}

// See-all destination for the All albums rail: the full paged collection.
function AllAlbumsView({ jf, nav, back, openMenu }: ViewProps) {
  const art = useArt();
  const list = usePagedList<Album>('lib:albums', (s, l) => jf.albums(s, l));
  const scroll = useScrollKeepAlive('albumlist:all', !!list.data);
  const { data, error, rawError, retry, loadingMore } = list;

  return (
    <div className="flex h-full flex-col">
      <TopBar title="All albums" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what="albums" nav={nav} />
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-x-4 gap-y-6">
              {data.map(a => (
                <GridCard
                  key={a.id}
                  title={a.name}
                  subtitle={a.artist}
                  art={art?.albumArt(a) ?? null}
                  onClick={() => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name })}
                  onMenu={() => openMenu(a.name, albumActions(a, jf, nav))}
                />
              ))}
            </div>
            {loadingMore && <p className="mt-4 text-center text-sm text-white/40">Loading more…</p>}
          </>
        ) : (
          <SkeletonGrid />
        )}
      </div>
    </div>
  );
}

export function AlbumListView(props: ViewProps & { kind: 'favorites' | 'recent' | 'all' }) {
  const { kind } = props;
  if (kind === 'all') return <AllAlbumsView {...props} />;
  return <BoundedAlbumListView {...props} kind={kind} />;
}

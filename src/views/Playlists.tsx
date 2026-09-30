import { useEffect, useState } from 'react';
import { playlistActions } from '../actions';
import { Empty, GridCard, publishAmbient, Rail, Tile, TopBar, useArt, useArtAccent } from '../components';
import { type Playlist } from '../jellyfin';
import type { ViewProps } from '../nav';
import { getRecentPlaylists, type RecentPlaylist } from '../recent';
import {
  ListError,
  RAIL_N,
  RailSkeleton,
  SkeletonGrid,
  useBounded,
  usePagedList,
  useScrollKeepAlive,
} from './listkit';

type AnyPlaylist = Playlist | RecentPlaylist;

// Playlists tab: Recently played rail (local play history, scrolls
// horizontally), Favorite playlists rail, then an All playlists rail with
// See all — all in the Recent-tracks rail design language.
export default function PlaylistsHome({ jf, nav, openMenu }: ViewProps) {
  const art = useArt();
  // Re-read on mount: returning from a playlist detail (where a play may
  // have been recorded) remounts this tab.
  const [recent] = useState<RecentPlaylist[]>(() => getRecentPlaylists());
  const favs = useBounded<Playlist>('playlists:favs', () => jf.favoritePlaylists(RAIL_N + 1));
  const all = usePagedList<Playlist>('lib:playlists', (s, l) => jf.playlists(s, l));
  const scroll = useScrollKeepAlive('playlists', !!all.data || !!favs.data);
  const err = favs.error ?? all.error;
  const rawErr = favs.error ? favs.rawError : all.rawError;

  // Blurred backdrop behind the transparent tab strip: first favorite
  // playlist, else the first playlist. Fixed so it paints behind the tabs.
  const ambientPl = favs.data?.[0] ?? all.data?.[0] ?? null;
  const ambientSrc = ambientPl && art ? (art.playlistArt(ambientPl, 160) ?? null) : null;
  const accent = useArtAccent(ambientSrc);
  // Publish to the single app-level tab-strip backdrop (nulls ignored so a
  // loading tab never blanks the previous tab's art).
  useEffect(() => {
    publishAmbient(ambientSrc, accent);
  }, [ambientSrc, accent]);

  const retryAll = () => {
    favs.retry();
    all.retry();
  };

  const tile = (p: AnyPlaylist) => (
    <Tile
      fluid
      key={p.id}
      size={120}
      title={p.name}
      subtitle={p.songCount ? `${p.songCount} tracks` : undefined}
      art={art?.playlistArt(p) ?? null}
      onClick={() => nav({ name: 'detail', kind: 'playlist', id: p.id, title: p.name })}
      onMenu={() => openMenu(p.name, playlistActions(p, jf, nav))}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto py-3">
        {err ? (
          <ListError error={err} rawError={rawErr} onRetry={retryAll} what="playlists" nav={nav} />
        ) : (
          <>
            {recent.length > 0 ? (
              <Rail
                title="Recently played"
                onSeeAll={
                  recent.length > RAIL_N
                    ? () => nav({ name: 'playlistlist', kind: 'recent' })
                    : undefined
                }
              >
                {recent.slice(0, RAIL_N).map(tile)}
              </Rail>
            ) : null}
            {favs.data ? (
              favs.data.length > 0 ? (
                <Rail
                  title="Favorite playlists"
                  onSeeAll={
                    favs.data.length > RAIL_N
                      ? () => nav({ name: 'playlistlist', kind: 'favorites' })
                      : undefined
                  }
                >
                  {favs.data.slice(0, RAIL_N).map(tile)}
                </Rail>
              ) : null
            ) : (
              <RailSkeleton />
            )}
            {all.data ? (
              all.data.length > 0 ? (
                <Rail
                  title="All playlists"
                  onSeeAll={
                    all.data.length > RAIL_N
                      ? () => nav({ name: 'playlistlist', kind: 'all' })
                      : undefined
                  }
                >
                  {all.data.slice(0, RAIL_N).map(tile)}
                </Rail>
              ) : (
                <Empty text="No playlists found." />
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

function PlaylistGridCard({
  p,
  jf,
  nav,
  openMenu,
}: ViewProps & { p: AnyPlaylist }) {
  const art = useArt();
  return (
    <GridCard
      key={p.id}
      title={p.name}
      subtitle={p.songCount ? `${p.songCount} tracks` : undefined}
      art={art?.playlistArt(p) ?? null}
      onClick={() => nav({ name: 'detail', kind: 'playlist', id: p.id, title: p.name })}
      onMenu={() => openMenu(p.name, playlistActions(p, jf, nav))}
    />
  );
}

function AllPlaylistsView({ jf, nav, back, openMenu }: ViewProps) {
  const list = usePagedList<Playlist>('lib:playlists', (s, l) => jf.playlists(s, l));
  const scroll = useScrollKeepAlive('playlistlist:all', !!list.data);
  const { data, error, rawError, retry, loadingMore } = list;

  return (
    <div className="flex h-full flex-col">
      <TopBar title="All playlists" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what="playlists" nav={nav} />
        ) : data ? (
          data.length > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-x-4 gap-y-6">
                {data.map(p => (
                  <PlaylistGridCard key={p.id} p={p} jf={jf} nav={nav} back={back} openMenu={openMenu} />
                ))}
              </div>
              {loadingMore && <p className="mt-4 text-center text-sm text-white/40">Loading more…</p>}
            </>
          ) : (
            <Empty text="No playlists found." />
          )
        ) : (
          <SkeletonGrid />
        )}
      </div>
    </div>
  );
}

function FavoritePlaylistsView({ jf, nav, back, openMenu }: ViewProps) {
  const list = useBounded<Playlist>('playlists:favs:all', () => jf.favoritePlaylists(200));
  const scroll = useScrollKeepAlive('playlistlist:favorites', !!list.data);
  const { data, error, rawError, retry } = list;

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Favorite playlists" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what="favorite playlists" nav={nav} />
        ) : data ? (
          data.length > 0 ? (
            <div className="grid grid-cols-3 gap-x-4 gap-y-6">
              {data.map(p => (
                <PlaylistGridCard key={p.id} p={p} jf={jf} nav={nav} back={back} openMenu={openMenu} />
              ))}
            </div>
          ) : (
            <Empty text="No favorite playlists yet. Long-press a playlist and favorite it." />
          )
        ) : (
          <SkeletonGrid />
        )}
      </div>
    </div>
  );
}

function RecentPlaylistsView({ jf, nav, back, openMenu }: ViewProps) {
  const [recent] = useState<RecentPlaylist[]>(() => getRecentPlaylists());
  const scroll = useScrollKeepAlive('playlistlist:recent', true);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Recently played" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {recent.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-4 gap-y-6">
            {recent.map(p => (
              <PlaylistGridCard key={p.id} p={p} jf={jf} nav={nav} back={back} openMenu={openMenu} />
            ))}
          </div>
        ) : (
          <Empty text="Play a playlist and it will show up here." />
        )}
      </div>
    </div>
  );
}

export function PlaylistListView(props: ViewProps & { kind: 'favorites' | 'recent' | 'all' }) {
  const { kind } = props;
  if (kind === 'all') return <AllPlaylistsView {...props} />;
  if (kind === 'recent') return <RecentPlaylistsView {...props} />;
  return <FavoritePlaylistsView {...props} />;
}

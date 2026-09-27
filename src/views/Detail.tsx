import { useEffect, useState } from 'react';
import { trackActions } from '../actions';
import { bust, cached, stickyBust, stickyGet, stickySet } from '../cache';
import {
  AmbientArt,
  Artwork,
  Empty,
  Icon,
  Rise,
  SkeletonRow,
  Tile,
  TopBar,
  TrackRow,
  friendlyError,
  useArt,
  useArtAccent,
  useLinkGen,
} from '../components';
import { player } from '../player';
import { recordPlaylistPlay } from '../recent';
import type { Album, Track } from '../jellyfin';
import type { ViewProps } from '../nav';

interface DetailParams {
  kind: 'album' | 'artist' | 'playlist' | 'genre';
  id: string;
  title: string;
}

interface StickyDetail {
  tracks: Track[];
  albums: Album[] | null;
}

function SkeletonDetail() {
  return (
    <div aria-hidden>
      <div className="mb-5 flex items-end gap-5">
        <div className="skeleton h-40 w-40 shrink-0 rounded-3xl" />
        <div className="min-w-0 flex-1 pb-1">
          <div className="skeleton h-9 w-3/4 rounded-lg" />
          <div className="skeleton mt-2 h-6 w-1/3 rounded-md" />
          <div className="mt-4 flex gap-3">
            <div className="skeleton h-16 w-36 rounded-full" />
            <div className="skeleton h-16 w-16 rounded-full" />
          </div>
        </div>
      </div>
      {[0, 1, 2, 3, 4].map(i => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

export default function Detail({ jf, nav, back, openMenu, params }: ViewProps & { params: DetailParams }) {
  const art = useArt();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [liked, setLiked] = useState<boolean | null>(null);
  const linkGen = useLinkGen();

  // The phone link dropping mid-load is the common failure here; when it
  // comes back, retry automatically instead of parking on the error.
  useEffect(() => {
    if (linkGen > 0 && error) setRetryKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkGen]);

  useEffect(() => {
    let dead = false;
    const skey = `detail:${params.kind}:${params.id}`;
    // stale detail beats a spinner: seed from the sticky cache, then
    // revalidate in the background and overwrite on success.
    const sticky = stickyGet<StickyDetail>(skey);
    if (sticky) {
      setTracks(sticky.tracks);
      setAlbums(sticky.albums);
    } else {
      setTracks(null);
      setAlbums(null);
    }
    setError(null);
    setLiked(null);
    if (params.kind === 'playlist') {
      jf.playlistIsFavorite(params.id).then(
        v => {
          if (!dead) setLiked(v);
        },
        () => {
          if (!dead) setLiked(false);
        },
      );
    }
    const load = async (): Promise<void> => {
      try {
        let ts: Track[];
        let as: Album[] | null = null;
        if (params.kind === 'album') {
          ts = await cached(`detail:album:${params.id}`, () => jf.albumTracks(params.id));
        } else if (params.kind === 'artist') {
          const [t2, a2] = await Promise.all([
            cached(`detail:artist-tracks:${params.id}`, () => jf.artistTracks(params.id)),
            cached(`detail:artist-albums:${params.id}`, () => jf.artistAlbums(params.id)),
          ]);
          ts = t2;
          as = a2;
        } else if (params.kind === 'playlist') {
          ts = await cached(`detail:playlist:${params.id}`, () => jf.playlistItems(params.id));
        } else {
          ts = await cached(`detail:genre:${params.id}`, () => jf.genreTracks(params.id));
        }
        if (dead) return;
        setTracks(ts);
        setAlbums(as);
        setError(null);
        stickySet(skey, { tracks: ts, albums: as } satisfies StickyDetail);
      } catch (e) {
        // refresh failures stay silent when sticky data is showing
        if (!dead && !sticky) setError(friendlyError(e));
      }
    };
    void load();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, params.kind, retryKey]);

  const playAll = (shuffle: boolean): void => {
    if (tracks?.length) {
      if (params.kind === 'playlist') {
        recordPlaylistPlay({ id: params.id, name: params.title, songCount: tracks.length, imageTag: null });
      }
      nav({ name: 'nowplaying' });
      void player.playQueue(tracks, 0, shuffle);
    }
  };

  const toggleLike = (): void => {
    if (params.kind !== 'playlist' || liked === null) return;
    const want = !liked;
    setLiked(want);
    jf.toggleFavorite(params.id, want).then(
      () => {
        // the favorites rails re-read on next mount; drop the stale copies
        bust('playlists:favs');
        stickyBust('playlists:favs');
      },
      () => setLiked(!want),
    );
  };

  // Header art: the first track's art carries the album/playlist cover for
  // every kind. The accent color is sampled from it.
  const headerArt = tracks?.[0] ? (art?.trackArt(tracks[0], 512) ?? null) : null;
  const accent = useArtAccent(headerArt);

  return (
    <div className="flex h-full flex-col">
      <TopBar title={params.title} onBack={back} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <AmbientArt src={headerArt} accent={accent} height={300} />
        <div className="relative px-5 py-5">
          {error ? (
            <Empty text={`Could not load: ${error}`} onRetry={() => setRetryKey(k => k + 1)} />
          ) : !tracks ? (
            <SkeletonDetail />
          ) : tracks.length === 0 ? (
            <Empty text="Nothing here yet." />
          ) : (
            <>
              <Rise>
                <div className="mb-6 flex items-end gap-5">
                  <div className="shrink-0 shadow-2xl shadow-black/60">
                    <Artwork src={headerArt} size={160} rounded="rounded-3xl" label={params.title} />
                  </div>
                  <div className="min-w-0 flex-1 pb-1">
                    <div className="text-3xl leading-tight font-bold tracking-tight">{params.title}</div>
                    <div className="mt-1 text-xl text-white/60">
                      {tracks.length} track{tracks.length === 1 ? '' : 's'}
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => playAll(false)}
                        style={accent ? { backgroundColor: accent } : undefined}
                        className={`flex h-16 shrink-0 items-center gap-2 rounded-full px-7 text-2xl font-bold text-black active:brightness-90 ${
                          accent ? '' : 'bg-leaf'
                        }`}
                      >
                        <Icon name="play" size={28} /> Play
                      </button>
                      <button
                        type="button"
                        aria-label="Shuffle play"
                        onClick={() => playAll(true)}
                        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
                      >
                        <Icon name="shuffle" size={28} />
                      </button>
                      {params.kind === 'playlist' ? (
                        <button
                          type="button"
                          aria-label={liked ? 'Unlike playlist' : 'Like playlist'}
                          onClick={toggleLike}
                          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/10 active:bg-white/20"
                        >
                          <Icon
                            name={liked ? 'heartFill' : 'heart'}
                            size={28}
                            className={liked ? 'text-leaf' : ''}
                          />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Rise>

              {albums && albums.length ? (
                <div className="mb-6">
                  <h2 className="mb-2.5 text-2xl font-bold tracking-tight">Albums</h2>
                  <div className="flex gap-4 overflow-x-auto pb-1">
                    {albums.map((a, i) => (
                      <Rise key={a.id} i={i}>
                        <Tile
                          size={180}
                          title={a.name}
                          subtitle={a.year ? String(a.year) : undefined}
                          art={art?.albumArt(a) ?? null}
                          onClick={() => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name })}
                        />
                      </Rise>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col">
                {tracks.map((t, i) => (
                  <Rise key={t.id} i={i}>
                    <TrackRow
                      track={t}
                      art={params.kind === 'album' ? null : art?.trackArt(t) ?? null}
                      showArt={params.kind !== 'album'}
                      indexLabel={params.kind === 'album' ? String(i + 1) : undefined}
                      onPlay={() => {
                        nav({ name: 'nowplaying' });
                        // Tapping the already-playing song opens Now Playing
                        // without restarting it.
                        if (player.current()?.id !== t.id) {
                          void player.playQueue(tracks, i);
                        }
                      }}
                      onToggle={() => {
                        if (player.current()?.id === t.id) {
                          void player.toggle();
                        } else {
                          nav({ name: 'nowplaying' });
                          void player.playQueue(tracks, i);
                        }
                      }}
                      onMenu={() => openMenu(t.name, trackActions(t, jf, nav))}
                    />
                  </Rise>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

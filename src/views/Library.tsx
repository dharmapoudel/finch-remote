import { AmbientArt, GridCard, Rail, Tile, TopBar, Spinner, useArt, useArtAccent } from '../components';
import { player } from '../player';
import { type Artist, type Genre } from '../jellyfin';
import type { JellyfinClient } from '../jellyfin';
import type { NavFn, ViewProps } from '../nav';
import {
  ListError,
  RAIL_N,
  RailSkeleton,
  SkeletonGrid,
  useBounded,
  usePagedList,
  useScrollKeepAlive,
} from './listkit';

function playArtist(jf: JellyfinClient, nav: NavFn, a: Artist, shuffle: boolean): void {
  jf.artistTracks(a.id)
    .then(ts => {
      if (ts.length) {
        nav({ name: 'nowplaying' });
        return player.playQueue(ts, 0, shuffle);
      }
    })
    .catch(() => {});
}

function artistMenu(jf: JellyfinClient, nav: NavFn, openMenu: ViewProps['openMenu'], a: Artist) {
  openMenu(a.name, [
    { label: 'Shuffle artist', icon: 'shuffle', run: () => playArtist(jf, nav, a, true) },
    { label: 'Play artist', icon: 'play', run: () => playArtist(jf, nav, a, false) },
  ]);
}

// Artwork loads on demand as tiles mount (IntersectionObserver + the
// 4-concurrent gate in components.tsx). The old warmArt prefetch fired up
// to 48 image fetches at the exact moment the list JSON was in flight,
// and that combined burst was knocking the Bluetooth link over — so no
// prefetch here; visible tiles still paint fast via the demand loader.

// ---- Library tab: Artists + Genres sections ----

export default function Library({ jf, nav, openMenu }: ViewProps) {
  const art = useArt();
  const artists = useBounded<Artist>('lib:artists:rail', () => jf.artists(0, RAIL_N + 1));
  const genres = useBounded<Genre>('lib:genres', () => jf.genres());
  const scroll = useScrollKeepAlive('library', !!artists.data || !!genres.data);
  const err = artists.error ?? genres.error;
  const rawErr = artists.error ? artists.rawError : genres.rawError;

  // Blurred backdrop behind the transparent tab strip: the first artist's
  // art. Fixed so it paints behind the tabs.
  const ambientArtist = artists.data?.[0] ?? null;
  const ambientSrc = ambientArtist && art ? (art.artistArt(ambientArtist, 256) ?? null) : null;
  const accent = useArtAccent(ambientSrc);

  return (
    <div className="flex h-full flex-col">
      <AmbientArt src={ambientSrc} accent={accent} height={340} fixed />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto py-3">
        {err ? (
          <ListError
            error={err}
            rawError={rawErr}
            onRetry={() => {
              artists.retry();
              genres.retry();
            }}
            what="the library"
            nav={nav}
          />
        ) : (
          <>
            {artists.data ? (
              <Rail
                title="Artists"
                onSeeAll={
                  artists.data.length > RAIL_N ? () => nav({ name: 'artists' }) : undefined
                }
              >
                {artists.data.slice(0, RAIL_N).map(a => (
                  <Tile
                      fluid
                    key={a.id}
                    size={140}
                    title={a.name}
                    art={art?.artistArt(a) ?? null}
                    onClick={() => nav({ name: 'detail', kind: 'artist', id: a.id, title: a.name })}
                    onMenu={() => artistMenu(jf, nav, openMenu, a)}
                  />
                ))}
              </Rail>
            ) : (
              <RailSkeleton />
            )}
            {genres.data ? (
              <Rail
                title="Genres"
                onSeeAll={
                  genres.data.length > RAIL_N ? () => nav({ name: 'genres' }) : undefined
                }
              >
                {genres.data.slice(0, RAIL_N).map(g => (
                  <Tile
                      fluid
                    key={g.id}
                    size={140}
                    title={g.name}
                    art={null}
                    onClick={() => nav({ name: 'detail', kind: 'genre', id: g.id, title: g.name })}
                  />
                ))}
              </Rail>
            ) : (
              <RailSkeleton />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Full lists (See-all destinations) ----

export function ArtistsAll({ jf, nav, back, openMenu }: ViewProps) {
  const art = useArt();
  const { data, loadingMore, error, rawError, retry } = usePagedList<Artist>('lib:artists', (s, l) =>
    jf.artists(s, l),
  );
  const scroll = useScrollKeepAlive('artists', !!data);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Artists" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what="artists" nav={nav} />
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-x-4 gap-y-6">
              {data.map(a => (
                <GridCard
                  key={a.id}
                  title={a.name}
                  art={art?.artistArt(a) ?? null}
                  onClick={() => nav({ name: 'detail', kind: 'artist', id: a.id, title: a.name })}
                  onMenu={() => artistMenu(jf, nav, openMenu, a)}
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

export function GenresAll({ jf, nav, back }: ViewProps) {
  const { data, error, rawError, retry } = useBounded<Genre>('lib:genres', () => jf.genres());
  const scroll = useScrollKeepAlive('genres', !!data);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Genres" onBack={back} />
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ListError error={error} rawError={rawError} onRetry={retry} what="genres" nav={nav} />
        ) : data ? (
          <div className="flex flex-wrap gap-3">
            {data.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => nav({ name: 'detail', kind: 'genre', id: g.id, title: g.name })}
                className="h-20 shrink-0 rounded-3xl bg-white/10 px-6 text-2xl font-medium active:bg-white/20"
              >
                {g.name}
              </button>
            ))}
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    </div>
  );
}


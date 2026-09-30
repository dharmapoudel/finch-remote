import { useEffect, useState } from 'react';
import { trackActions } from '../actions';
import { cached, stickyGet, stickySet } from '../cache';
import {
  Artwork,
  AuthError,
  Empty,
  publishAmbient,
  Rail,
  Rise,
  SkeletonRow,
  SkeletonTile,
  Tile,
  useArt,
  useArtAccent,
  usePlayer,
  type MenuAction,
} from '../components';
import { player } from '../player';
import { isAuthError, type Album, type Track } from '../jellyfin';
import type { ViewProps } from '../nav';
import { RAIL_N } from './listkit';

function useLoad<T>(key: string | null, load: () => Promise<T>): {
  data: T | null;
  error: string | null;
  rawError: unknown;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  useEffect(() => {
    if (!key) return;
    let dead = false;
    setError(null);
    setRawError(null);
    // Seed from the sticky cache first: a cold start paints the last known
    // rails instantly, then the network refresh replaces them silently.
    const sticky = stickyGet<T>(key);
    setData(sticky);
    cached(key, load).then(
      d => {
        if (dead) return;
        setData(d);
        stickySet(key, d);
      },
      (e: unknown) => {
        if (dead) return;
        if (sticky) return; // stale data beats an error banner
        setError(e instanceof Error ? e.message : 'could not load');
        setRawError(e);
      },
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error, rawError };
}

function SkeletonHome() {
  return (
    <div className="py-2" aria-hidden>
      {[0, 1].map(r => (
        <section key={r} className="mb-7">
          <div className="skeleton mx-5 mb-2 h-4 w-40 rounded" />
          <div className="flex gap-4 overflow-hidden px-5">
            {[0, 1, 2, 3].map(i => (
              <SkeletonTile key={i} size={140} />
            ))}
          </div>
        </section>
      ))}
      <section className="px-3">
        <div className="skeleton mx-2 mb-2.5 h-8 w-36 rounded-lg" />
        {[0, 1, 2].map(i => (
          <SkeletonRow key={i} />
        ))}
      </section>
    </div>
  );
}

export default function Home({ jf, nav, openMenu }: ViewProps) {
  const art = useArt();
  usePlayer();
  // The track Finch is actually playing right now (adopted on app start
  // when the phone kept playing across a restart): highlight its tile in
  // Continue listening, and tapping it opens Now Playing without
  // restarting it from scratch.
  const nowId = player.current()?.id ?? null;
  const nowActive =
    nowId !== null && !player.external && !player.error && (player.intentPlaying || player.loading);

  const recent = useLoad<Track[]>('home:recent', () => jf.recentlyPlayedTracks(RAIL_N + 1));
  const added = useLoad<Album[]>('home:added', () => jf.recentlyAddedAlbums(4));
  // Server-side limit: fetching every favorite as one giant JSON blob was
  // knocking the Bluetooth link over; only RAIL_N + 1 are ever fetched
  // (5 shown, the +1 reveals whether See all is needed).
  const favs = useLoad<Track[]>('home:favs', () => jf.favorites(RAIL_N + 1));

  // Ambient backdrop: the now-playing track's art when something is active,
  // otherwise the most recent track's. The accent glow is sampled from it.
  // Fixed so it paints behind the transparent top tab strip as well.
  const ambientTrack =
    (nowActive ? recent.data?.find(t => t.id === nowId) : null) ?? recent.data?.[0] ?? null;
  const ambientSrc = ambientTrack && art ? (art.trackArt(ambientTrack, 160) ?? null) : null;
  const accent = useArtAccent(ambientSrc);
  // The single app-level backdrop (outside the animated view wrapper, which
  // would trap it) shows this tab's art. Nulls are ignored by the bus so a
  // loading tab never blanks the previous tab's backdrop.
  useEffect(() => {
    publishAmbient(ambientSrc, accent);
  }, [ambientSrc, accent]);

  // No artwork prefetch on Home mount: the rails' JSON is in flight at the
  // same moment, and the combined burst was dropping the Bluetooth link.
  // Visible tiles load on demand via the IntersectionObserver loader.

  const menuFor = (t: Track): MenuAction[] => trackActions(t, jf, nav);

  const anyError = recent.error || added.error || favs.error;

  return (
    <div className="relative h-full overflow-y-auto">
      <div className="relative pb-5 pt-3">
        {anyError ? (
          isAuthError(recent.rawError) ||
          isAuthError(added.rawError) ||
          isAuthError(favs.rawError) ? (
            <AuthError
              text="Jellyfin rejected the saved sign-in. Reconnect with Quick Connect or an API key."
              onReconnect={() => nav({ name: 'setup' })}
            />
          ) : (
            <Empty text="Could not reach Jellyfin. Check the server URL and API key in settings." />
          )
        ) : null}

        {recent.data ? (
          <Rise>
            <Rail
              title="Recent tracks"
              onSeeAll={
                recent.data.length > RAIL_N
                  ? () => nav({ name: 'recenttracks' })
                  : undefined
              }
            >
              {recent.data.slice(0, RAIL_N).map((t, i) => {
                const isCurrent = nowActive && t.id === nowId;
                return (
                  <Rise key={t.id} i={i}>
                    <Tile
                      fluid
                      size={140}
                      title={t.name}
                      subtitle={t.artist}
                      art={art?.trackArt(t) ?? null}
                      active={isCurrent}
                      onClick={() => {
                        nav({ name: 'nowplaying' });
                        // Tapping the currently-playing tile just opens Now
                        // Playing; every other tile starts it from scratch.
                        if (!isCurrent) void player.playQueue(recent.data!, recent.data!.indexOf(t));
                      }}
                      onMenu={() => openMenu(t.name, menuFor(t))}
                    />
                  </Rise>
                );
              })}
            </Rail>
          </Rise>
        ) : (
          !recent.error && <SkeletonHome />
        )}

        {added.data ? (
          <Rise>
            <section className="mb-7 shrink-0">
              <div className="mb-3 flex items-center justify-between px-5">
                <h2 className="text-xs font-semibold uppercase tracking-[0.22em] text-white/80">
                  Recently added
                </h2>
                <button
                  type="button"
                  onClick={() => nav({ name: 'albums' })}
                  className="rounded-full px-4 py-2 text-lg font-medium text-goldlight active:bg-white/10"
                >
                  See all
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-4 px-5">
                {added.data.map((a, i) => (
                  <Rise key={a.id} i={i}>
                    <button
                      type="button"
                      onClick={() => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name })}
                      className="flex w-full items-center gap-3 pb-4 text-left active:opacity-80"
                    >
                      <Artwork src={art?.albumArt(a) ?? null} size={56} rounded="rounded-lg" label={a.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-lg font-medium text-white">{a.name}</span>
                        <span className="block truncate text-base text-white/50">
                          {a.songCount > 0 ? `${a.songCount} Tracks | ` : ''}
                          {a.artist}
                        </span>
                      </span>
                    </button>
                  </Rise>
                ))}
              </div>
            </section>
          </Rise>
        ) : null}

        {favs.data && favs.data.length ? (
          <Rise>
            <Rail
              title="Favorites"
              onSeeAll={
                favs.data.length > RAIL_N ? () => nav({ name: 'favorites' }) : undefined
              }
            >
              {favs.data.slice(0, RAIL_N).map((t, i) => {
                const isCurrent = nowActive && t.id === nowId;
                return (
                  <Rise key={t.id} i={i}>
                    <Tile
                      fluid
                      size={140}
                      title={t.name}
                      subtitle={t.artist}
                      art={art?.trackArt(t) ?? null}
                      active={isCurrent}
                      onClick={() => {
                        nav({ name: 'nowplaying' });
                        // Tapping the currently-playing tile just opens Now
                        // Playing; every other tile starts it from scratch.
                        if (!isCurrent) void player.playQueue(favs.data!, favs.data!.indexOf(t));
                      }}
                      onMenu={() => openMenu(t.name, menuFor(t))}
                    />
                  </Rise>
                );
              })}
            </Rail>
          </Rise>
        ) : null}
      </div>
    </div>
  );
}

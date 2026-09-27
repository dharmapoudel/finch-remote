import { useEffect, useState } from 'react';
import { trackActions } from '../actions';
import { cached } from '../cache';
import {
  AuthError,
  Empty,
  Rise,
  SkeletonRow,
  TopBar,
  TrackRow,
  friendlyError,
  useArt,
  useLinkGen,
  usePlayer,
  type MenuAction,
} from '../components';
import { isAuthError, type Track } from '../jellyfin';
import type { ViewProps } from '../nav';
import { player } from '../player';

// Full-screen recent-tracks list: the "See all" destination for the Home
// Recent tracks rail. Fetches up to 100 recent tracks (track JSON is tiny;
// artwork still loads on demand through the gated loader).
export default function RecentTracks({ jf, nav, back, openMenu }: ViewProps) {
  const art = useArt();
  usePlayer();
  const linkGen = useLinkGen();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let dead = false;
    setError(null);
    setRawError(null);
    cached<Track[]>('recent:all', () => jf.recentlyPlayedTracks(100)).then(
      d => {
        if (!dead) setTracks(d);
      },
      e => {
        if (!dead) {
          setError(friendlyError(e));
          setRawError(e);
        }
      },
    );
    return () => {
      dead = true;
    };
  }, [jf, retryKey]);

  // The phone link dropping mid-load is the common failure here; when it
  // comes back, retry automatically instead of parking on the error.
  useEffect(() => {
    if (linkGen > 0 && error) setRetryKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkGen]);

  const menuFor = (t: Track): MenuAction[] => trackActions(t, jf, nav);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Recent tracks" onBack={back} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          isAuthError(rawError) ? (
            <AuthError
              text="Jellyfin rejected the saved sign-in. Reconnect with Quick Connect or an API key."
              onReconnect={() => nav({ name: 'setup' })}
            />
          ) : (
            <Empty text={`Could not load recent tracks: ${error}`} onRetry={() => setRetryKey(k => k + 1)} />
          )
        ) : tracks ? (
          tracks.map((t, i) => (
            <Rise key={t.id} i={Math.min(i, 8)}>
              <TrackRow
                track={t}
                art={art?.trackArt(t) ?? null}
                onPlay={() => {
                  nav({ name: 'nowplaying' });
                  void player.playQueue(tracks, tracks.indexOf(t));
                }}
                onMenu={() => openMenu(t.name, menuFor(t))}
              />
            </Rise>
          ))
        ) : (
          [0, 1, 2, 3, 4].map(i => <SkeletonRow key={i} />)
        )}
      </div>
    </div>
  );
}

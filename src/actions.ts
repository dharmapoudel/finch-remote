// context-menu actions shared by the views.
import { player } from './player';
import { bust, stickyBust } from './cache';
import { recordPlaylistPlay } from './recent';
import { JellyfinClient, type Album, type Playlist, type Track } from './jellyfin';
import type { MenuAction } from './components';
import type { NavFn } from './nav';

export function trackActions(t: Track, jf: JellyfinClient, nav: NavFn): MenuAction[] {
  return [
    { label: 'Play next', icon: 'queue', run: () => player.playNext(t) },
    { label: 'Add to queue', icon: 'plus', run: () => player.addToQueue(t) },
    {
      label: t.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      icon: 'heart',
      run: () => {
        const want = !t.isFavorite;
        t.isFavorite = want;
        player.touch();
        jf.toggleFavorite(t.id, want).catch(() => {
          t.isFavorite = !want;
          player.touch();
        });
      },
    },
    {
      label: 'Start instant mix',
      icon: 'mix',
      run: () => {
        jf.instantMixFor(t.id)
          .then(mix => {
            if (mix.length) {
              nav({ name: 'nowplaying' });
              return player.playQueue(mix, 0);
            }
          })
          .catch(() => {});
      },
    },
    ...(t.albumId
      ? [{ label: 'Go to album', icon: 'library' as const, run: () => nav({ name: 'detail', kind: 'album', id: t.albumId!, title: t.album }) }]
      : []),
  ];
}

export function albumActions(a: Album, jf: JellyfinClient, nav: NavFn): MenuAction[] {
  const tracks = (shuffle: boolean): Promise<void> =>
    jf
      .albumTracks(a.id)
      .then(ts => {
        if (ts.length) {
          nav({ name: 'nowplaying' });
          return player.playQueue(ts, 0, shuffle);
        }
      })
      .catch(() => {});
  return [
    { label: 'Play album', icon: 'play', run: () => tracks(false) },
    { label: 'Shuffle album', icon: 'shuffle', run: () => tracks(true) },
    {
      label: 'Add album to queue',
      icon: 'plus',
      run: () => {
        jf.albumTracks(a.id)
          .then(ts => ts.forEach(t => player.addToQueue(t)))
          .catch(() => {});
      },
    },
    {
      label: 'Start instant mix',
      icon: 'mix',
      run: () => {
        jf.instantMixFor(a.id)
          .then(mix => {
            if (mix.length) {
              nav({ name: 'nowplaying' });
              return player.playQueue(mix, 0);
            }
          })
          .catch(() => {});
      },
    },
    {
      label: a.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      icon: 'heart',
      run: () => {
        jf.toggleFavorite(a.id, !a.isFavorite).catch(() => {});
      },
    },
    { label: 'Open album', icon: 'library', run: () => nav({ name: 'detail', kind: 'album', id: a.id, title: a.name }) },
  ];
}

export function playlistActions(p: Playlist, jf: JellyfinClient, nav: NavFn): MenuAction[] {
  const tracks = (shuffle: boolean): Promise<void> =>
    jf
      .playlistItems(p.id)
      .then(ts => {
        if (ts.length) {
          recordPlaylistPlay(p);
          nav({ name: 'nowplaying' });
          return player.playQueue(ts, 0, shuffle);
        }
      })
      .catch(() => {});
  return [
    { label: 'Play playlist', icon: 'play', run: () => tracks(false) },
    { label: 'Shuffle playlist', icon: 'shuffle', run: () => tracks(true) },
    {
      label: p.isFavorite ? 'Remove from favorites' : 'Add to favorites',
      icon: 'heart',
      run: () => {
        const want = !p.isFavorite;
        p.isFavorite = want;
        jf.toggleFavorite(p.id, want).then(
          () => {
            bust('playlists:favs');
            stickyBust('playlists:favs');
          },
          () => {
            p.isFavorite = !want;
          },
        );
      },
    },
    { label: 'Open playlist', icon: 'library', run: () => nav({ name: 'detail', kind: 'playlist', id: p.id, title: p.name }) },
  ];
}

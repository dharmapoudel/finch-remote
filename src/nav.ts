// in-app navigation. single full-screen page; views swap, Escape/back pops.
export type View =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'playlists' }
  | { name: 'albums' }
  | { name: 'artists' }
  | { name: 'genres' }
  | { name: 'albumlist'; kind: 'favorites' | 'recent' | 'all' }
  | { name: 'playlistlist'; kind: 'favorites' | 'recent' | 'all' }
  | { name: 'favorites' }
  | { name: 'recenttracks' }
  | { name: 'detail'; kind: 'album' | 'artist' | 'playlist' | 'genre'; id: string; title: string; imageTag?: string | null }
  | { name: 'nowplaying' }
  | { name: 'queue' }
  | { name: 'setup' };

export type NavFn = (v: View) => void;

export interface ViewProps {
  jf: import('./jellyfin').JellyfinClient;
  nav: NavFn;
  back: () => void;
  openMenu: (title: string, actions: import('./components').MenuAction[]) => void;
}

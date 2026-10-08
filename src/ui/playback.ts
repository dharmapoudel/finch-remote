// The bridge between Finch's own remote-control state (App.tsx, unchanged
// 1.3.1 logic) and the 1.4.0 screens. Views read state from usePb() and call
// Pb.act.*; they never talk to Jellyfin's session API themselves.
import { createContext, useContext } from 'react';
import type { Api } from '../demo';
import type { Item, Session } from '../jellyfin';
import type { MenuAction } from './components';

export type Actions = {
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (ms: number) => void;
  toggleFav: () => void;
  setFavorite: (item: Item, on: boolean) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleLyrics: () => void;
  playItems: (items: Item[], start?: number, label?: string) => Promise<void>;
  queueItems: (items: Item[], next: boolean) => Promise<void>;
  instantMix: (item: Item) => Promise<void>;
  chooseTarget: (s: Session) => void;
  openNowPlaying: () => void;
  openPlayOn: () => void;
  toast: (msg: string) => void;
};

export type Pb = {
  api: Api | null;
  sessions: Session[];
  sessionsLoaded: boolean;
  pollError: string | null;
  target: Session | null;
  /** What Now Playing shows (the last track while the next one loads). */
  item: Item | null;
  nowId: string | null;
  paused: boolean;
  loadingTrack: boolean;
  durationMs: number;
  /** Live playhead (ms), from the 1.3.1 clock. Stable function. */
  positionNow: () => number;
  isFav: boolean;
  favOf: (item: Item) => boolean;
  shuffle: boolean;
  repeat: 'RepeatNone' | 'RepeatAll' | 'RepeatOne';
  showLyrics: boolean;
  act: Actions;
};

export const PbCtx = createContext<Pb | null>(null);
/** Everything, refreshed on every session poll: Now Playing and Play on only. */
export function usePb(): Pb {
  const pb = useContext(PbCtx);
  if (!pb) throw new Error('usePb outside PbCtx');
  return pb;
}

// 1.4.1: browse screens and rows read two narrow contexts instead of usePb(),
// so a session poll (every 2-5 s) no longer re-renders every tile and row:
// Core changes only when the Jellyfin client changes, Now only when the
// playing track, pause state or a favorite changes (Finch 1.3.1 re-rendered
// its lists only on those changes too).
export type Core = { api: Api | null; act: Actions; userKey: string };
export const CoreCtx = createContext<Core | null>(null);
export function useCore(): Core {
  const c = useContext(CoreCtx);
  if (!c) throw new Error('useCore outside CoreCtx');
  return c;
}

export type Now = { nowId: string | null; paused: boolean; favOf: (item: Item) => boolean };
export const NowCtx = createContext<Now | null>(null);
export function useNow(): Now {
  const n = useContext(NowCtx);
  if (!n) throw new Error('useNow outside NowCtx');
  return n;
}

/** What the browse screens and context menus need: Core + Now. */
export type Lite = Core & Now;
export function useLite(): Lite {
  const c = useCore();
  const n = useNow();
  return { ...c, ...n };
}

// ---- in-app navigation (finch-remote's view stack, remote-only subset) ----
export type View =
  | { name: 'home' }
  | { name: 'playlists' }
  | { name: 'albums' }
  | { name: 'library' }
  | { name: 'artists' }
  /** recent = recently added, played = recently played (1.4.3) */
  | { name: 'albumlist'; kind: 'recent' | 'all' | 'played' | 'favorites' }
  | { name: 'playlistlist'; kind: 'favorites' | 'all' | 'recent' }
  | { name: 'favorites' }
  | { name: 'recenttracks' }
  | { name: 'genres' }
  | { name: 'genrealbums'; item: Item }
  | { name: 'detail'; item: Item };

export type NavFn = (v: View) => void;
export type MiniState = 'hidden' | 'mini' | 'sliver';

export type Ui = {
  nav: NavFn;
  back: () => void;
  openMenu: (title: string, actions: MenuAction[]) => void;
};
export const UiCtx = createContext<Ui | null>(null);
export function useUi(): Ui {
  const ui = useContext(UiCtx);
  if (!ui) throw new Error('useUi outside UiCtx');
  return ui;
}

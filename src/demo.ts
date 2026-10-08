import type { Item, Jellyfin, Page, Session } from './jellyfin';
import { TICKS_PER_MS } from './jellyfin';

/** Public surface of the Jellyfin client; the demo implements the same shape. */
export type Api = { [K in keyof Jellyfin]: Jellyfin[K] };

// Dev-only fixtures (`?demo` in the URL) so the UI can be built and
// screenshotted without a daemon, a phone, or a Jellyfin server.

const PALETTE = [
  ['#aa5cc3', '#00a4dc'],
  ['#ff7a59', '#ffcf5c'],
  ['#2fd1a5', '#1d6fd8'],
  ['#e0457b', '#5b2a86'],
  ['#3ddc84', '#0a7e8c'],
  ['#f2994a', '#9b51e0'],
];

const ALBUMS: Item[] = [
  ['Blue Hour Drive', 'Quiet Houses', 2023],
  ['Northern Lights', 'Aurora Fields', 2021],
  ['Low Tide', 'Saltwater Choir', 2019],
  ['Neon Arcade', 'Pixel Static', 2024],
  ['Paper Moons', 'The Lanterns', 2018],
  ['Gravel Roads', 'Henry Vale', 2022],
  ['Midnight Diner', 'Velvet Static', 2020],
  ['Coastline', 'Saltwater Choir', 2024],
  ['Analog Hearts', 'Pixel Static', 2017],
  ['Summer Static', 'Aurora Fields', 2016],
].map(([name, artist, year], i) => ({
  Id: `album-${i}`,
  Name: String(name),
  Type: 'MusicAlbum',
  AlbumArtist: String(artist),
  ProductionYear: Number(year),
  ChildCount: 9 + (i % 4),
  ImageTags: { Primary: `p${i}` },
  UserData: { IsFavorite: i % 3 === 0 },
}));

// 1.4.3: genres. Album i belongs to GENRE_NAMES[i % 5]; the last genre has
// no albums (shows the placeholder tile). None has its own picture, so the
// demo borrows an album cover the way jellyfin.ts does.
const GENRE_NAMES = ['Indie', 'Electronic', 'Folk', 'Synthwave', 'Jazz', 'Spoken Word'];
const GENRES: Item[] = GENRE_NAMES.map((name, gi) => {
  const first = ALBUMS.find((_, i) => i % 5 === gi);
  return {
    Id: `genre-${gi}`,
    Name: name,
    Type: 'MusicGenre',
    ...(first ? { AlbumId: first.Id, AlbumPrimaryImageTag: first.ImageTags?.Primary } : {}),
  };
});
const albumsOfGenre = (id: string) => ALBUMS.filter((_, i) => `genre-${i % 5}` === id);

const ARTISTS: Item[] = [...new Set(ALBUMS.map(a => a.AlbumArtist!))].map((name, i) => ({
  Id: `artist-${i}`,
  Name: name,
  Type: 'MusicArtist',
  ChildCount: ALBUMS.filter(a => a.AlbumArtist === name).length,
  ImageTags: { Primary: `a${i}` },
}));

const PLAYLISTS: Item[] = ['Road Trip', 'Morning Commute', 'Late Night Focus', 'Sing-Alongs', 'Rainy Day'].map(
  (name, i) => ({
    Id: `pl-${i}`,
    Name: name,
    Type: 'Playlist',
    ChildCount: 20 + i * 7,
    // 'Rainy Day' has no cover of its own: its first track's album art stands in
    ImageTags: name === 'Rainy Day' ? undefined : { Primary: `l${i}` },
    UserData: { IsFavorite: i < 2 || i === 4 },
  }),
);

const TRACK_NAMES = [
  'Headlights',
  'Mile Marker',
  'Golden Exit',
  'Cruise Control',
  'Overpass',
  'Service Station',
  'Last Toll',
  'Windows Down',
  'Rearview',
  'Home Stretch',
  'Night Shift',
  'Static Bloom',
];

function tracksFor(album: Item): Item[] {
  const n = album.ChildCount ?? 10;
  return Array.from({ length: n }, (_, i) => ({
    Id: `${album.Id}-t${i}`,
    Name: TRACK_NAMES[i % TRACK_NAMES.length],
    Type: 'Audio',
    Album: album.Name,
    AlbumId: album.Id,
    AlbumArtist: album.AlbumArtist,
    Artists: [album.AlbumArtist ?? ''],
    IndexNumber: i + 1,
    RunTimeTicks: (150 + ((i * 37) % 120)) * 1000 * TICKS_PER_MS,
    AlbumPrimaryImageTag: album.ImageTags?.Primary,
    UserData: { IsFavorite: i % 4 === 0 },
  }));
}

const ALL_TRACKS = ALBUMS.flatMap(tracksFor);

// play history, newest first (what Jellyfin's DatePlayed sort returns). The
// newest three come from the 'Sing-Alongs' playlist played in another app
// (Finamp), 4 min apart: the playlist index should find it.
const playedAt = (t: Item, ago: number): Item => ({
  ...t,
  UserData: { ...t.UserData, Played: true, LastPlayedDate: new Date(Date.now() - ago).toISOString() },
});
const PLAYED: Item[] = [
  ...[3, 13, 23].map((n, k) => playedAt(ALL_TRACKS[n], (5 + k * 4) * 60_000)),
  ...[17, 25, 40, 41, 58, 66, 71, 80, 92].map((n, k) => playedAt(ALL_TRACKS[n % ALL_TRACKS.length], (k + 2) * 3_600_000)),
];
function notePlayed(t: Item | undefined) {
  if (!t) return;
  const i = PLAYED.findIndex(x => x.Id === t.Id);
  if (i >= 0) PLAYED.splice(i, 1);
  PLAYED.unshift({ ...t, UserData: { ...t.UserData, Played: true, LastPlayedDate: new Date().toISOString() } });
}
function tracksOfPlaylist(parent: Item): Item[] {
  return ALL_TRACKS.filter((_, i) => i % 5 === Number(parent.Id.slice(-1))).slice(0, 25);
}

/** Fixed items the ?demo&view=… screenshots open (detail, artist, playlist). */
export const DEMO_SAMPLE = { album: ALBUMS[0], artist: ARTISTS[0], playlist: PLAYLISTS[0], genre: GENRES[0] };

function svgArt(seed: string, label: string): Uint8Array {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTE[h % PALETTE.length];
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="${20 + (h % 60)}" cy="${30 + (h % 40)}" r="${18 + (h % 20)}" fill="#fff" opacity=".14"/><text x="50" y="62" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="30" fill="#fff" opacity=".9">${initials}</text></svg>`;
  return new TextEncoder().encode(svg);
}

const page = (items: Item[], start: number, limit: number): Page<Item> => ({
  Items: items.slice(start, start + limit),
  TotalRecordCount: items.length,
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function createDemoApi(): Api {
  const now = tracksFor(ALBUMS[0])[2];
  const state = {
    item: now as Item | undefined,
    queue: tracksFor(ALBUMS[0]),
    index: 2,
    positionMs: 74_000,
    startedAt: Date.now(),
    paused: false,
    volume: 42,
    shuffle: false,
    repeat: 'RepeatNone' as 'RepeatNone' | 'RepeatAll' | 'RepeatOne',
  };
  const pos = () => (state.paused ? state.positionMs : state.positionMs + (Date.now() - state.startedAt));
  const freeze = () => {
    state.positionMs = pos();
    state.startedAt = Date.now();
  };
  const jump = (i: number) => {
    state.index = Math.max(0, Math.min(state.queue.length - 1, i));
    // real players report no item for a moment while the next track buffers
    state.item = undefined as unknown as typeof state.item;
    setTimeout(() => {
      state.item = state.queue[state.index];
      notePlayed(state.item);
      state.positionMs = 0;
      state.startedAt = Date.now();
    }, 1600);
  };
  const sessions: Session[] = [
    {
      Id: 's-phone',
      DeviceId: 'd-phone',
      DeviceName: 'iPhone',
      Client: 'Finamp',
      SupportsRemoteControl: true,
      LastActivityDate: new Date().toISOString(),
    },
    {
      Id: 's-tv',
      DeviceId: 'd-tv',
      DeviceName: 'Living Room TV',
      Client: 'Jellyfin Web',
      SupportsRemoteControl: true,
      LastActivityDate: new Date().toISOString(),
    },
  ];

  const api: Api = {
    withPriority() {
      return api as unknown as Jellyfin;
    },
    creds: { serverUrl: 'http://demo', token: 'demo', userId: 'demo', deviceId: 'demo' },
    async albums(start = 0, limit = 60, sort = 'SortName') {
      await sleep(150);
      const list = sort === 'SortName' ? [...ALBUMS].sort((a, b) => a.Name.localeCompare(b.Name)) : [...ALBUMS].reverse();
      return page(list, start, limit);
    },
    async artists(start = 0, limit = 60) {
      await sleep(150);
      return page(ARTISTS, start, limit);
    },
    async playlists(start = 0, limit = 60) {
      await sleep(150);
      return page(PLAYLISTS, start, limit);
    },
    async favoriteTracks(start = 0, limit = 100) {
      await sleep(150);
      return page(
        ALL_TRACKS.filter(t => t.UserData?.IsFavorite),
        start,
        limit,
      );
    },
    recentPlays(start = 0, limit = 100) {
      return api.recentTracks(start, limit);
    },
    async recentTracks(start = 0, limit = 60) {
      await sleep(150);
      return page(PLAYED, start, limit);
    },
    async recentAlbums(limit = 30) {
      await sleep(150);
      const ids = [...new Set(PLAYED.map(t => t.AlbumId!))].slice(0, limit);
      const out = ids.map(id => ALBUMS.find(a => a.Id === id)!).filter(Boolean);
      return page(out, 0, out.length);
    },
    async favoriteAlbums(start = 0, limit = 60) {
      await sleep(150);
      return page(
        ALBUMS.filter(a => a.UserData?.IsFavorite),
        start,
        limit,
      );
    },
    async playedPlaylists() {
      // the demo server "stamps" two playlists; Finch adds its own record
      return [PLAYLISTS[2], PLAYLISTS[4]].map((p, k) => ({
        ...p,
        UserData: { ...p.UserData, LastPlayedDate: new Date(Date.now() - (k + 2) * 86_400_000).toISOString() },
      }));
    },
    async playlistSigs() {
      return { items: PLAYLISTS.map(p => ({ Id: p.Id, Name: p.Name, Type: 'Playlist', ChildCount: tracksOfPlaylist(p).length })), bytes: 0 };
    },
    async playlistIdsOnly(playlistId) {
      const p = PLAYLISTS.find(x => x.Id === playlistId);
      return p ? { ids: tracksOfPlaylist(p).map(t => t.Id), bytes: 0 } : null;
    },
    async playlistItemIds(playlistId, start = 0, limit = 100) {
      const p = PLAYLISTS.find(x => x.Id === playlistId);
      const all = p ? tracksOfPlaylist(p).map(t => t.Id) : [];
      return { ids: all.slice(start, start + limit), total: all.length, bytes: 0 };
    },
    async playlistFirstTrack(playlistId) {
      const p = PLAYLISTS.find(x => x.Id === playlistId);
      return p ? (tracksOfPlaylist(p)[0] ?? null) : null;
    },
    async genres(start = 0, limit = 60) {
      await sleep(150);
      return page(GENRES, start, limit);
    },
    async genreAlbums(genreId, start = 0, limit = 60) {
      await sleep(120);
      return page(albumsOfGenre(genreId), start, limit);
    },
    async genreTracks(genreId, limit = 300) {
      await sleep(120);
      return page(albumsOfGenre(genreId).flatMap(tracksFor), 0, limit);
    },
    async artistAlbums(artistId) {
      const artist = ARTISTS.find(a => a.Id === artistId);
      return page(
        ALBUMS.filter(a => a.AlbumArtist === artist?.Name),
        0,
        200,
      );
    },
    async tracks(parent) {
      await sleep(120);
      if (parent.Type === 'Playlist') return tracksOfPlaylist(parent);
      return tracksFor(parent);
    },
    async instantMix(itemId) {
      return ALL_TRACKS.filter((t, i) => t.Id !== itemId && i % 5 === 0);
    },
    async setFavorite(itemId, favorite) {
      for (const t of ALL_TRACKS) if (t.Id === itemId) t.UserData = { IsFavorite: favorite };
      if (state.item?.Id === itemId) state.item = { ...state.item, UserData: { IsFavorite: favorite } };
    },
    async image(item) {
      const seed = item.ImageTags?.Primary ?? item.AlbumPrimaryImageTag ?? item.Id;
      const label = item.Type === 'Audio' ? (item.Album ?? item.Name) : item.Name;
      return { bytes: svgArt(seed, label), mime: 'image/svg+xml' };
    },
    async sessions() {
      await sleep(80);
      if (state.item && pos() > (state.item.RunTimeTicks ?? 0) / TICKS_PER_MS) jump(state.index + 1);
      return sessions.map(s =>
        s.Id === 's-phone'
          ? {
              ...s,
              NowPlayingItem: state.item,
              PlayState: {
                PositionTicks: pos() * TICKS_PER_MS,
                IsPaused: state.paused,
                VolumeLevel: state.volume,
                ShuffleMode: state.shuffle ? 'Shuffle' : 'Sorted',
                RepeatMode: state.repeat,
              },
              positionMs: pos(),
              positionAt: Date.now(),
            }
          : s,
      );
    },
    async playNow(_sid, ids, startIndex = 0) {
      state.queue = ids.map(id => ALL_TRACKS.find(t => t.Id === id)!).filter(Boolean);
      state.paused = false;
      jump(startIndex);
    },
    async queue(_sid, ids) {
      state.queue.push(...ids.map(id => ALL_TRACKS.find(t => t.Id === id)!).filter(Boolean));
    },
    async command(_sid, cmd) {
      if (cmd === 'PlayPause') {
        freeze();
        state.paused = !state.paused;
      } else if (cmd === 'Pause') {
        freeze();
        state.paused = true;
      } else if (cmd === 'Unpause') {
        freeze();
        state.paused = false;
      } else if (cmd === 'NextTrack') jump(state.index + 1);
      else if (cmd === 'PreviousTrack') jump(pos() > 3000 ? state.index : state.index - 1);
      else if (cmd === 'Stop') state.item = undefined;
    },
    async seek(_sid, ms) {
      // real players take a moment to apply a seek and report back
      setTimeout(() => {
        state.positionMs = ms;
        state.startedAt = Date.now();
      }, 700);
    },
    async setShuffle(_sid, s) {
      state.shuffle = s;
    },
    async setRepeat(_sid, r) {
      state.repeat = r;
    },
    async lyrics(itemId) {
      await sleep(200);
      const t = ALL_TRACKS.find(x => x.Id === itemId);
      if (!t) return null;
      const words = [
        'Headlights pour across the empty road',
        'Radio humming something that I know',
        'Every mile a little further from the cold',
        '',
        'Windows down and the night is open wide',
        'Your hand out catching wind like it was tide',
        'We never said where we were going, just to drive',
        '',
        'Oh, keep it rolling',
        'Oh, keep it glowing',
        'Till the morning finds us somewhere new',
        '',
        'Gas station coffee and a paper map',
        'Singing every chorus, every gap',
        'Wherever this is going, I am glad',
        '',
        'Oh, keep it rolling',
        'Oh, keep it glowing',
        'Till the morning finds us somewhere new',
      ];
      const dur = (t.RunTimeTicks ?? 0) / TICKS_PER_MS;
      const step = (dur - 12_000) / words.length;
      return { synced: true, lines: words.map((text, i) => ({ text, startMs: 8_000 + i * step })) };
    },
    async serverName() {
      return 'Demo Server';
    },
  };
  return api;
}

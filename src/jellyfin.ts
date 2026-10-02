// Jellyfin REST client. Every call tunnels through the phone via
// client.net.fetch, so it works with no CORS and away from home as long as
// the phone can reach the server. Auth rides two ways on every request:
// the modern `Authorization: MediaBrowser ...` header with the token
// embedded (the only header form Jellyfin honors once legacy authorization
// is disabled — every X-Emby-* header is silently ignored there), and the
// `ApiKey` query param (capital A — the lowercase `api_key` variant is a
// legacy alias and is ignored too; the query param is required for stream
// and image URLs, where no headers can be sent).

import { getClient } from './client';
import { gatedNet } from './netgate';

export const FINCH_VERSION = '0.1.11';

// Trailing slashes turn every path into a double-slash (//Users/...) which
// some servers and reverse proxies reject — strip them once, up front.
export function normalizeServer(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export interface Creds {
  server: string;
  apiKey: string;
  userId: string;
}

export interface Track {
  id: string;
  name: string;
  albumId: string | null;
  album: string;
  artist: string;
  durationMs: number;
  isFavorite: boolean;
  playCount: number;
  imageTag: string | null;
  albumImageTag: string | null;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  songCount: number;
  imageTag: string | null;
  isFavorite: boolean;
}

export interface Artist {
  id: string;
  name: string;
  imageTag: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  imageTag: string | null;
  songCount: number;
  isFavorite?: boolean;
}

export interface Genre {
  id: string;
  name: string;
}

export interface SearchHits {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

// Lyrics. Jellyfin 10.9+ extracts embedded lyrics (ID3 USLT, Vorbis LYRICS,
// …) during scans and serves them at GET /Audio/{itemId}/Lyrics as a
// LyricDto: { Metadata: { IsSynced, Offset, … }, Lyrics: [{ Text, Start }] }.
// Times are 100ns ticks (ms = ticks / 10_000). LyricLine has NO End field —
// a line runs until the next line starts. 404 = no lyrics for the track.
export interface LyricLineVM {
  startMs: number; // -1 when the line carries no timestamp (unsynced)
  endMs: number; // derived from the next line's start; -1 when unsynced
  text: string;
}

export interface ParsedLyrics {
  lines: LyricLineVM[];
  isSynced: boolean;
}

interface RawLyricLine {
  Text?: string;
  Start?: number | null;
  Cues?: unknown;
}

interface RawLyricDto {
  Metadata?: {
    IsSynced?: boolean | null;
    Offset?: number | null; // lyric offset vs audio, in ticks
  };
  Lyrics?: RawLyricLine[];
}

const TICKS_PER_MS = 10_000;

function parseLyricDto(dto: RawLyricDto, durationMs: number): ParsedLyrics | null {
  const raw = (dto.Lyrics ?? []).filter(l => (l.Text ?? '').trim().length > 0);
  if (!raw.length) return null;
  // Offset shifts every line relative to the audio; Jellyfin reports it in ticks.
  const offsetMs = Math.round((dto.Metadata?.Offset ?? 0) / TICKS_PER_MS);
  const lines: LyricLineVM[] = raw.map(l => ({
    startMs: l.Start != null ? Math.max(0, Math.round(l.Start / TICKS_PER_MS) + offsetMs) : -1,
    endMs: -1,
    text: (l.Text ?? '').trim(),
  }));
  const synced = lines.some(l => l.startMs >= 0);
  if (synced) {
    for (let i = 0; i < lines.length; i++) {
      lines[i].endMs =
        i + 1 < lines.length
          ? lines[i + 1].startMs
          : durationMs > 0
            ? durationMs
            : lines[i].startMs + 60_000;
    }
  }
  return { lines, isSynced: synced && dto.Metadata?.IsSynced !== false };
}

export class JellyfinError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// True when the server rejected the credentials (as opposed to a network or
// server error) — the UI uses this to offer a reconnect path.
export function isAuthError(e: unknown): boolean {
  return e instanceof JellyfinError && (e.status === 401 || e.status === 403);
}

export interface RawSession {
  Id: string;
  UserId?: string;
  DeviceId?: string;
  DeviceName?: string;
  Client?: string;
  LastActivityDate?: string;
  NowPlayingItem?: RawItem | null;
  PlayState?: { IsPaused?: boolean; PositionTicks?: number } | null;
}

interface RawItem {
  Id: string;
  Name: string;
  Type?: string;
  AlbumId?: string;
  Album?: string;
  Artists?: string[];
  AlbumArtist?: string;
  RunTimeTicks?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProductionYear?: number;
  ChildCount?: number;
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
  UserData?: { IsFavorite?: boolean; PlayCount?: number; Played?: boolean };
}

const FETCH_TIMEOUT_MS = 15_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

// Include a snippet of the server's error body — Jellyfin/ASP.NET usually
// names the exact complaint in it, which beats guessing from the status code.
function errBody(body: Uint8Array): string {
  try {
    const t = dec.decode(body).replace(/\s+/g, ' ').trim();
    return t ? `: ${t.slice(0, 220)}` : '';
  } catch {
    return '';
  }
}

// Stable device id shared with the playback engine (player.ts uses the same
// store key). Sent in the X-Emby-Authorization header.
const DEVICE_ID_KEY = 'finch:device-id';
let deviceIdCache: string | null = null;

export async function finchDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;
  const client = getClient();
  try {
    const r = await client.store.get({ key: DEVICE_ID_KEY });
    if (r.ok && r.response.value) {
      deviceIdCache = r.response.value;
      return deviceIdCache;
    }
  } catch {
    // fall through to generate
  }
  deviceIdCache = crypto.randomUUID();
  try {
    await client.store.put({ key: DEVICE_ID_KEY, value: deviceIdCache });
  } catch {
    // non-fatal
  }
  return deviceIdCache;
}

function cleanServer(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

export function normalizeTrack(raw: RawItem): Track {
  return {
    id: raw.Id,
    name: raw.Name,
    albumId: raw.AlbumId ?? null,
    album: raw.Album ?? '',
    artist: raw.Artists?.join(', ') ?? raw.AlbumArtist ?? 'Unknown artist',
    durationMs: Math.round((raw.RunTimeTicks ?? 0) / 10_000),
    isFavorite: raw.UserData?.IsFavorite ?? false,
    playCount: raw.UserData?.PlayCount ?? 0,
    imageTag: raw.ImageTags?.Primary ?? null,
    albumImageTag: raw.AlbumPrimaryImageTag ?? null,
  };
}

export function normalizeAlbum(raw: RawItem): Album {
  return {
    id: raw.Id,
    name: raw.Name,
    artist: raw.AlbumArtist ?? raw.Artists?.join(', ') ?? 'Unknown artist',
    year: raw.ProductionYear ?? null,
    songCount: raw.ChildCount ?? 0,
    imageTag: raw.ImageTags?.Primary ?? null,
    isFavorite: raw.UserData?.IsFavorite ?? false,
  };
}

export function normalizeArtist(raw: RawItem): Artist {
  return { id: raw.Id, name: raw.Name, imageTag: raw.ImageTags?.Primary ?? null };
}

export function normalizePlaylist(raw: RawItem): Playlist {
  return {
    id: raw.Id,
    name: raw.Name,
    imageTag: raw.ImageTags?.Primary ?? null,
    songCount: raw.ChildCount ?? 0,
    isFavorite: raw.UserData?.IsFavorite ?? false,
  };
}

export class JellyfinClient {
  private creds: Creds;

  constructor(creds: Creds) {
    this.creds = { ...creds, server: cleanServer(creds.server) };
  }

  get server(): string {
    return this.creds.server;
  }
  get userId(): string {
    return this.creds.userId;
  }

  private url(path: string, params: Record<string, string | number | boolean> = {}): string {
    const q = new URLSearchParams({ ApiKey: this.creds.apiKey });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `${this.creds.server}${path}?${q.toString()}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean> = {},
    body?: unknown,
    // 'front': user-initiated commands (pause/next/seek/play) jump the net
    // gate queue so a tap never waits behind artwork fetches.
    priority: 'front' | 'back' = 'back',
  ): Promise<T> {
    const client = getClient();
    // Auth rides two ways: the modern `Authorization` header with the token
    // embedded (required — with legacy authorization disabled, Jellyfin
    // ignores X-Emby-Token, X-Emby-Authorization and the lowercase api_key
    // query param entirely) plus the `ApiKey` query param (capital A),
    // which stream and image URLs need because no headers can be sent there.
    const deviceId = await finchDeviceId();
    const headers = [
      {
        name: 'Authorization',
        value:
          `MediaBrowser Client="Finch", Device="Car Thing", DeviceId="${deviceId}", ` +
          `Version="${FINCH_VERSION}", Token="${this.creds.apiKey}"`,
      },
    ];
    if (body) headers.push({ name: 'Content-Type', value: 'application/json' });
    // Every tunneled request draws from the shared 3-slot gate (netgate):
    // the phone buffers each reply fully, so unbounded concurrency wedges it.
    const res = await gatedNet(
      () =>
        client.net.fetch({
          request: {
            url: this.url(path, params),
            method,
            headers,
            body: body ? enc.encode(JSON.stringify(body)) : null,
            timeoutMs: FETCH_TIMEOUT_MS,
            redirect: 'follow',
          },
        }),
      priority,
    );
    if (!res.ok) {
      const e = res.error;
      const kind = 'error' in e ? (e.error.type === 'requestFailed' ? e.error.data.reason : e.error.type) : e.type;
      throw new JellyfinError(0, `network error: ${kind}`);
    }
    const r = res.response.response;
    if (r.status === 401 || r.status === 403) {
      const keyHint = this.creds.apiKey ? `${this.creds.apiKey.slice(0, 4)}…` : '(empty)';
      throw new JellyfinError(
        r.status,
        `unauthorized (${r.status}): the server rejected the credentials Finch is using — ${this.creds.server} with key ${keyHint}. Re-check them in the Finch settings on your phone.`,
      );
    }
    if (r.status >= 400) {
      throw new JellyfinError(r.status, `server error ${r.status}${errBody(r.body)}`);
    }
    const text = dec.decode(r.body);
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }

  private async items<T>(
    params: Record<string, string | number | boolean>,
    map: (r: RawItem) => T,
  ): Promise<T[]> {
    const data = await this.request<{ Items?: RawItem[] }>(
      'GET',
      `/Users/${this.creds.userId}/Items`,
      { Recursive: true, ...params },
    );
    return (data.Items ?? []).map(map);
  }

  // Bluetooth-tunneled HTTP has no room for unbounded payloads: every list
  // query that can return a large library takes a server-side Limit (and
  // StartIndex for paging). A limit of 0 omits the param (unbounded).
  private static bounded(
    params: Record<string, string | number | boolean>,
    startIndex: number,
    limit: number,
  ): Record<string, string | number | boolean> {
    if (startIndex > 0) params.StartIndex = startIndex;
    if (limit > 0) params.Limit = limit;
    return params;
  }

  albums(startIndex = 0, limit = 0): Promise<Album[]> {
    return this.items(
      JellyfinClient.bounded(
        { IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName', SortOrder: 'Ascending' },
        startIndex,
        limit,
      ),
      normalizeAlbum,
    );
  }

  albumTracks(albumId: string): Promise<Track[]> {
    return this.items(
      {
        ParentId: albumId,
        IncludeItemTypes: 'Audio',
        SortBy: 'ParentIndexNumber,IndexNumber,SortName',
        SortOrder: 'Ascending',
      },
      normalizeTrack,
    );
  }

  artists(startIndex = 0, limit = 0): Promise<Artist[]> {
    return this.items(
      JellyfinClient.bounded(
        { IncludeItemTypes: 'MusicArtist', SortBy: 'SortName', SortOrder: 'Ascending' },
        startIndex,
        limit,
      ),
      normalizeArtist,
    );
  }

  artistTracks(artistId: string, limit = 500): Promise<Track[]> {
    return this.items(
      JellyfinClient.bounded(
        { ArtistIds: artistId, IncludeItemTypes: 'Audio', SortBy: 'Album,SortName', SortOrder: 'Ascending' },
        0,
        limit,
      ),
      normalizeTrack,
    );
  }

  artistAlbums(artistId: string): Promise<Album[]> {
    return this.items(
      { ArtistIds: artistId, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', SortOrder: 'Ascending' },
      normalizeAlbum,
    );
  }

  playlists(startIndex = 0, limit = 0): Promise<Playlist[]> {
    return this.items(
      JellyfinClient.bounded(
        { IncludeItemTypes: 'Playlist', SortBy: 'SortName', SortOrder: 'Ascending' },
        startIndex,
        limit,
      ),
      normalizePlaylist,
    );
  }

  favoritePlaylists(limit = 50): Promise<Playlist[]> {
    return this.items(
      JellyfinClient.bounded(
        {
          Filters: 'IsFavorite',
          IncludeItemTypes: 'Playlist',
          SortBy: 'SortName',
          SortOrder: 'Ascending',
        },
        0,
        limit,
      ),
      normalizePlaylist,
    );
  }

  playlistItems(playlistId: string, limit = 500): Promise<Track[]> {
    return this.items(
      JellyfinClient.bounded({ ParentId: playlistId, IncludeItemTypes: 'Audio' }, 0, limit),
      normalizeTrack,
    );
  }

  async playlistIsFavorite(playlistId: string): Promise<boolean> {
    const data = await this.request<RawItem>('GET', `/Users/${this.creds.userId}/Items/${playlistId}`);
    return data.UserData?.IsFavorite ?? false;
  }

  async genres(): Promise<Genre[]> {
    const data = await this.request<{ Items?: RawItem[] }>('GET', '/MusicGenres', {
      UserId: this.creds.userId,
      Recursive: true,
    });
    return (data.Items ?? []).map(g => ({ id: g.Id, name: g.Name }));
  }

  genreTracks(genreId: string): Promise<Track[]> {
    return this.items({ GenreIds: genreId, IncludeItemTypes: 'Audio', SortBy: 'SortName' }, normalizeTrack);
  }

  favorites(limit = 0): Promise<Track[]> {
    return this.items(
      JellyfinClient.bounded(
        { Filters: 'IsFavorite', IncludeItemTypes: 'Audio', SortBy: 'SortName' },
        0,
        limit,
      ),
      normalizeTrack,
    );
  }

  favoriteAlbums(limit = 50): Promise<Album[]> {
    return this.items(
      JellyfinClient.bounded(
        { Filters: 'IsFavorite', IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName' },
        0,
        limit,
      ),
      normalizeAlbum,
    );
  }

  async toggleFavorite(itemId: string, favorite: boolean): Promise<void> {
    const path = `/Users/${this.creds.userId}/FavoriteItems/${itemId}`;
    await this.request<void>(favorite ? 'POST' : 'DELETE', path);
  }

  recentlyAddedAlbums(limit = 20): Promise<Album[]> {
    return this.items(
      {
        IncludeItemTypes: 'MusicAlbum',
        SortBy: 'DateCreated,SortName',
        SortOrder: 'Descending',
        Limit: limit,
      },
      normalizeAlbum,
    );
  }

  recentlyPlayedTracks(limit = 20): Promise<Track[]> {
    return this.items(
      {
        IncludeItemTypes: 'Audio',
        SortBy: 'DatePlayed,SortName',
        SortOrder: 'Descending',
        Limit: limit,
      },
      normalizeTrack,
    );
  }

  shuffleAll(limit = 200): Promise<Track[]> {
    return this.items({ IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: limit }, normalizeTrack);
  }

  async instantMixFor(itemId: string, limit = 50): Promise<Track[]> {
    const data = await this.request<{ Items?: RawItem[] }>('GET', `/Items/${itemId}/InstantMix`, {
      UserId: this.creds.userId,
      IncludeItemTypes: 'Audio',
      Limit: limit,
    });
    return (data.Items ?? []).map(normalizeTrack);
  }

  async searchHints(term: string): Promise<SearchHits> {
    const data = await this.request<{ SearchHints?: RawItem[] }>('GET', '/Search/Hints', {
      SearchTerm: term,
      MediaTypes: 'Audio,MusicAlbum,MusicArtist',
      Limit: 25,
    });
    const hits: SearchHits = { tracks: [], albums: [], artists: [] };
    for (const h of data.SearchHints ?? []) {
      if (h.Type === 'Audio') hits.tracks.push(normalizeTrack(h));
      else if (h.Type === 'MusicAlbum') hits.albums.push(normalizeAlbum(h));
      else if (h.Type === 'MusicArtist') hits.artists.push(normalizeArtist(h));
    }
    return hits;
  }

  // Playback stream. Auth must ride in the query string: the phone's stream
  // provider sends no headers, only Icy-MetaData: 1.
  // AudioCodec lists ONLY what the iPhone (AVPlayer) can direct-play.
  // Claiming opus/flac used to make the server direct-play them and the
  // phone then failed every such track ("Playback failed"); unlisted codecs
  // now transcode to MP3 instead. startMs restarts a transcode at an offset
  // (StartTimeTicks) — the fallback for seeking inside transcoded streams,
  // which AVPlayer cannot range-seek because they are live ffmpeg pipes.
  streamUrl(trackId: string, deviceId: string, startMs = 0): string {
    const params: Record<string, string | number> = {
      UserId: this.creds.userId,
      DeviceId: deviceId,
      AudioCodec: 'mp3,aac,alac',
      TranscodingContainer: 'mp3',
      TranscodingProtocol: 'http',
    };
    if (startMs > 0) params.StartTimeTicks = Math.round(startMs * 10_000);
    return this.url(`/Audio/${trackId}/universal`, params);
  }

  // Plain <img> needs no CORS, so artwork goes straight at the server.
  // Tile art is 160px / q80: tiles render at 120-140px, so this is crisp
  // with far fewer bytes over the Bluetooth link than the old 256.
  imageUrl(itemId: string, width = 160): string {
    return this.url(`/Items/${itemId}/Images/Primary`, { fillWidth: width, quality: 80 });
  }

  // Artwork for a track: its own image, else its album's.
  trackImage(track: Track, width = 160): string | null {
    if (track.imageTag) return this.imageUrl(track.id, width);
    if (track.albumId) return this.imageUrl(track.albumId, width);
    return null;
  }

  // Scrobbling: Jellyfin session playback reporting.
  reportPlaying(itemId: string, sessionId: string): Promise<void> {
    return this.request<void>('POST', '/Sessions/Playing', {}, {
      ItemId: itemId,
      PlayMethod: 'Transcode',
      PlaySessionId: sessionId,
      CanSeek: true,
      IsPaused: false,
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  reportProgress(itemId: string, sessionId: string, positionMs: number, paused: boolean): Promise<void> {
    return this.request<void>('POST', '/Sessions/Playing/Progress', {}, {
      ItemId: itemId,
      PositionTicks: Math.round(positionMs * 10_000),
      IsPaused: paused,
      PlaySessionId: sessionId,
      CanSeek: true,
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  reportStopped(itemId: string, sessionId: string, positionMs: number): Promise<void> {
    return this.request<void>('POST', '/Sessions/Playing/Stopped', {}, {
      ItemId: itemId,
      PositionTicks: Math.round(positionMs * 10_000),
      PlaySessionId: sessionId,
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  // Remote control of another Jellyfin session ("Play on", the same
  // mechanism Jellyfin Web uses; Finamp implements the receiving end).
  // Sessions are limited to the ones this user is allowed to drive.
  async rawSessions(): Promise<RawSession[]> {
    return this.request<RawSession[]>('GET', '/Sessions', { ControllableByUserId: this.creds.userId });
  }

  /** One session only — far smaller than the full /Sessions list, so the
   *  track-switch polls fly through the Bluetooth tunnel faster. */
  async rawSession(sessionId: string): Promise<RawSession | null> {
    try {
      return await this.request<RawSession>('GET', `/Sessions/${encodeURIComponent(sessionId)}`, {});
    } catch {
      return null;
    }
  }

  // PlaystateCommand for one session: Pause/Unpause/NextTrack/
  // PreviousTrack/Seek (with SeekPositionTicks)/Stop.
  async remotePlaystate(sessionId: string, command: string, body: Record<string, unknown>): Promise<void> {
    await this.request<void>(
      'POST',
      `/Sessions/${encodeURIComponent(sessionId)}/Playing/${encodeURIComponent(command)}`,
      {},
      body,
      'front',
    );
  }

  // Instruct one session to start playing items (the client builds its own
  // queue from ItemIds, starting at StartIndex).
  async remotePlay(sessionId: string, itemIds: string[], startIndex = 0): Promise<void> {
    // NOTE: the route is /Playing (not /Play) and every argument is a query
    // parameter — see SessionController.Play in the Jellyfin source. A body
    // is not accepted.
    //
    // Cap the list: every id rides in the URL query string, and a 500-track
    // playlist makes a ~16KB URL that wedges the Bluetooth tunnel (the phone
    // buffers the whole net.fetch reply; huge URLs drop the link). 200 ids
    // ≈ 6.4KB, safe. The user can still reach the rest from the phone.
    const MAX_IDS = 200;
    const ids = itemIds.length > MAX_IDS ? itemIds.slice(0, MAX_IDS) : itemIds;
    if (itemIds.length > MAX_IDS) startIndex = Math.min(startIndex, MAX_IDS - 1);
    const params: Record<string, string | number | boolean> = {
      playCommand: 'PlayNow',
      itemIds: ids.join(','),
    };
    if (startIndex > 0) params.startIndex = startIndex;
    await this.request<void>('POST', `/Sessions/${encodeURIComponent(sessionId)}/Playing`, params, undefined, 'front');
  }

  // Resume detection: fetch one library item as a Track.
  async trackById(itemId: string): Promise<Track> {
    const raw = await this.request<RawItem>('GET', `/Users/${this.creds.userId}/Items/${itemId}`, {});
    return normalizeTrack(raw);
  }

  // Primary image tag for any library item. The playlist detail screen only
  // loads tracks, never the playlist item itself — this fills the gap when
  // recording a playlist play for the recently-played rail.
  async itemImageTag(itemId: string): Promise<string | null> {
    const raw = await this.request<RawItem>('GET', `/Users/${this.creds.userId}/Items/${itemId}`, {});
    return raw.ImageTags?.Primary ?? null;
  }

  // Resume detection: is OUR device already playing something on the server?
  // Only our own DeviceId counts — never claim another client's playback.
  // Stale sessions (no activity for a while) are ignored.
  async serverNowPlaying(): Promise<{ track: Track; positionMs: number; paused: boolean } | null> {
    const sessions = await this.request<RawSession[]>('GET', '/Sessions', {});
    const deviceId = await finchDeviceId();
    const s = sessions.find(x => x.DeviceId === deviceId && x.NowPlayingItem?.Id);
    if (!s?.NowPlayingItem) return null;
    if (s.LastActivityDate) {
      const ageMs = Date.now() - new Date(s.LastActivityDate).getTime();
      if (!Number.isFinite(ageMs) || ageMs > 15 * 60_000) return null;
    }
    return {
      track: normalizeTrack(s.NowPlayingItem),
      positionMs: Math.round((s.PlayState?.PositionTicks ?? 0) / 10_000),
      paused: s.PlayState?.IsPaused ?? false,
    };
  }

  // Lyrics need server ≥ 10.9 (the Lyrics API debuted there). Cache the
  // version so Now Playing doesn't refetch it per track.
  private versionCache: { major: number; minor: number } | null | undefined;

  async serverVersion(): Promise<{ major: number; minor: number }> {
    if (this.versionCache === undefined) {
      try {
        const info = await this.request<{ Version?: string }>('GET', '/System/Info');
        const m = /^(\d+)\.(\d+)/.exec(info.Version ?? '');
        this.versionCache = m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
      } catch {
        this.versionCache = null;
      }
    }
    return this.versionCache ?? { major: 0, minor: 0 };
  }

  async lyricsSupported(): Promise<boolean> {
    const v = await this.serverVersion();
    // A failed version check (link hiccup) must not hide the lyrics
    // toggle: fail open. The per-track fetch still dims the toggle when a
    // track actually has no lyrics.
    if (v.major === 0 && v.minor === 0) return true;
    return v.major > 10 || (v.major === 10 && v.minor >= 9);
  }

  // Embedded lyrics for one track. 404 (no lyrics) and any other failure
  // both resolve to null — missing lyrics must never break Now Playing.
  // Results are cached per track id so re-opening Now Playing is free.
  private lyricsCache = new Map<string, ParsedLyrics | null>();

  async getLyrics(itemId: string, durationMs = 0): Promise<ParsedLyrics | null> {
    const hit = this.lyricsCache.get(itemId);
    if (hit !== undefined) return hit;
    let parsed: ParsedLyrics | null = null;
    try {
      const dto = await this.request<RawLyricDto>('GET', `/Audio/${itemId}/Lyrics`);
      parsed = dto ? parseLyricDto(dto, durationMs) : null;
    } catch {
      parsed = null;
    }
    this.lyricsCache.set(itemId, parsed);
    return parsed;
  }
}

// One-off connection test used by the settings page and onboarding.
export async function testConnection(server: string, apiKey: string): Promise<{ userId: string; userName: string }> {
  const clean = cleanServer(server);
  const key = apiKey.trim();
  const client = getClient();
  const deviceId = await finchDeviceId();
  const headers = [
    {
      name: 'Authorization',
      value:
        `MediaBrowser Client="Finch", Device="Car Thing", DeviceId="${deviceId}", ` +
        `Version="${FINCH_VERSION}", Token="${key}"`,
    },
  ];
  const res = await client.net.fetch({
    request: {
      url: `${clean}/System/Info?ApiKey=${encodeURIComponent(key)}`,
      method: 'GET',
      headers,
      body: null,
      timeoutMs: FETCH_TIMEOUT_MS,
      redirect: 'follow',
    },
  });
  if (!res.ok) throw new JellyfinError(0, 'could not reach the server; check the URL and that the phone has network');
  if (res.response.response.status === 401 || res.response.response.status === 403) {
    throw new JellyfinError(401, `the server rejected that API key (${res.response.response.status})`);
  }
  if (res.response.response.status >= 400) {
    throw new JellyfinError(res.response.response.status, `server error ${res.response.response.status}${errBody(res.response.response.body)}`);
  }
  // System/Info needs no user; now find the user id for library calls.
  const usersRes = await client.net.fetch({
    request: {
      url: `${clean}/Users?ApiKey=${encodeURIComponent(key)}`,
      method: 'GET',
      headers,
      body: null,
      timeoutMs: FETCH_TIMEOUT_MS,
      redirect: 'follow',
    },
  });
  if (!usersRes.ok) throw new JellyfinError(0, 'connected, but could not list users');
  const users = JSON.parse(dec.decode(usersRes.response.response.body)) as { Id: string; Name: string }[];
  if (!users.length) throw new JellyfinError(0, 'connected, but the server returned no users');
  return { userId: users[0].Id, userName: users[0].Name };
}

// ---- Quick Connect -------------------------------------------------------
// Jellyfin's device-linking flow: the device asks for a code (no token
// needed, though the client identification header still is), the user types it into Jellyfin (user menu → Quick Connect, or a
// Jellyfin app's settings), approves it, and the device trades the secret
// for a real access token + user id. Nothing to type on the Car Thing.

export interface QuickConnectSession {
  secret: string;
  code: string;
}

async function qcFetch<T>(server: string, path: string, opts?: { body?: unknown; post?: boolean }): Promise<T> {
  const clean = cleanServer(server);
  const client = getClient();
  // No token exists yet at this point, but Jellyfin still needs the client
  // identification header on these endpoints: TryConnect throws
  // ArgumentException (=> 400 "Error processing request.") when DeviceId,
  // Device, Client or Version are missing. The MODERN `Authorization` header
  // is required here, not just `X-Emby-Authorization` — recent Jellyfin runs
  // a migration that disables legacy authorization, and with it off the
  // server silently ignores every X-Emby-* header, so the client info never
  // reaches the parser. (This is also why Finamp works: it sends the
  // `Authorization` header.) We send both with identical values; the server
  // prefers `Authorization` when both are present.
  const deviceId = await finchDeviceId();
  const authValue =
    `MediaBrowser Client="Finch", Device="Car Thing", DeviceId="${deviceId}", Version="${FINCH_VERSION}"`;
  const headers: { name: string; value: string }[] = [
    { name: 'Authorization', value: authValue },
    { name: 'X-Emby-Authorization', value: authValue },
  ];
  const hasBody = opts?.body !== undefined;
  const method = hasBody || opts?.post ? 'POST' : 'GET';
  if (hasBody) headers.push({ name: 'Content-Type', value: 'application/json' });
  const res = await client.net.fetch({
    request: {
      url: `${clean}${path}`,
      method,
      headers,
      body: hasBody ? enc.encode(JSON.stringify(opts.body)) : null,
      timeoutMs: FETCH_TIMEOUT_MS,
      redirect: 'follow',
    },
  });
  if (!res.ok) throw new JellyfinError(0, 'could not reach the server; check the URL and that the phone has network');
  const r = res.response.response;
  if (r.status >= 400) throw new JellyfinError(r.status, `server error ${r.status}${errBody(r.body)}`);
  return JSON.parse(dec.decode(r.body)) as T;
}

// Step 1: get a secret + the 6-digit code to show the user. No token needed,
// but the client identification header (sent by qcFetch) is required.
// Initiate is POST-only on Jellyfin; the POST carries no body.
// Note: Jellyfin returns PascalCase keys (Secret, Code) — map them to our
// camelCase session, otherwise the secret is undefined and the poll 404s.
export async function quickConnectInitiate(server: string): Promise<QuickConnectSession> {
  const data = await qcFetch<{ Secret?: string; Code?: string }>(server, '/QuickConnect/Initiate', { post: true });
  if (!data.Secret || !data.Code) {
    throw new JellyfinError(0, 'the server did not return a Quick Connect code.');
  }
  return { secret: data.Secret, code: data.Code };
}

// Step 2: poll until the user approves the code in Jellyfin.
export async function quickConnectPoll(server: string, secret: string): Promise<boolean> {
  const data = await qcFetch<{ Authenticated?: boolean }>(
    server,
    `/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`,
  );
  return data.Authenticated === true;
}

// Step 3: trade the approved secret for an access token + user. The token
// endpoint lives on the Users controller, not the QuickConnect controller:
// POST /Users/AuthenticateWithQuickConnect with { Secret }.
export async function quickConnectAuthenticate(
  server: string,
  secret: string,
): Promise<{ apiKey: string; userId: string; userName: string }> {
  const data = await qcFetch<{ AccessToken?: string; User?: { Id?: string; Name?: string } }>(
    server,
    '/Users/AuthenticateWithQuickConnect',
    { body: { Secret: secret } },
  );
  if (!data.AccessToken || !data.User?.Id) {
    throw new JellyfinError(0, 'the server did not return a token — approve the code in Jellyfin first.');
  }
  return { apiKey: data.AccessToken, userId: data.User.Id, userName: data.User.Name ?? 'Jellyfin user' };
}

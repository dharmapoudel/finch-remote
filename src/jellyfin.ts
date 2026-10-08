import type { BridgethingClient } from '@bridgething/client';

/**
 * Minimal Jellyfin REST client. The Car Thing has no network of its own, so
 * every request is tunnelled through the companion phone with
 * `client.net.fetch`. Jellyfin is a plain HTTP(S) JSON API.
 *
 * The Car Thing is a remote: it never plays audio itself. It browses the
 * library and drives a Jellyfin "session" (the Jellyfin app on your phone,
 * Finamp, Jellyfin Web on a TV, a Kodi box, ...) through the Sessions API.
 */

export const APP_NAME = 'Finch';
export const APP_VERSION = '1.4.4';
export const DEVICE_NAME = 'Car Thing';

export type Credentials = {
  serverUrl: string;
  token: string;
  userId: string;
  deviceId: string;
};

export type ItemKind = 'MusicAlbum' | 'MusicArtist' | 'MusicGenre' | 'Playlist' | 'Audio' | 'Folder' | string;

export type Item = {
  Id: string;
  Name: string;
  Type: ItemKind;
  AlbumArtist?: string;
  Artists?: string[];
  Album?: string;
  AlbumId?: string;
  RunTimeTicks?: number;
  ProductionYear?: number;
  ChildCount?: number;
  IndexNumber?: number;
  ImageTags?: Record<string, string>;
  AlbumPrimaryImageTag?: string;
  UserData?: { IsFavorite?: boolean; Played?: boolean; PlayCount?: number; LastPlayedDate?: string };
  /** playlists (1.4.3): when the playlist was last saved; with ChildCount it
   *  tells the playlist index which playlists changed */
  DateLastSaved?: string;
  /** albums only, when asked for with Fields=GenreItems (genre art fallback) */
  GenreItems?: { Id: string; Name: string }[];
};

export type Session = {
  Id: string;
  DeviceId: string;
  DeviceName: string;
  Client: string;
  UserName?: string;
  SupportsRemoteControl: boolean;
  SupportedCommands?: string[];
  LastActivityDate?: string;
  /** when the player last sent a progress report (server clock, ISO) */
  LastPlaybackCheckIn?: string;
  NowPlayingItem?: Item;
  /** added by Finch: best estimate of the playhead at local time `positionAt` */
  positionMs?: number;
  positionAt?: number;
  PlayState?: {
    PositionTicks?: number;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    RepeatMode?: 'RepeatNone' | 'RepeatAll' | 'RepeatOne';
    ShuffleMode?: 'Sorted' | 'Shuffle';
  };
  NowPlayingQueue?: { Id: string }[];
};

export type LyricLine = { text: string; startMs: number | null };
export type Lyrics = { lines: LyricLine[]; synced: boolean };

export type Page<T> = { Items: T[]; TotalRecordCount: number };

export const TICKS_PER_MS = 10_000;

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** `MediaBrowser ...` authorization header Jellyfin expects from every client. */
export function authHeader(deviceId: string, token?: string): string {
  const parts = [
    `Client="${APP_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${APP_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const out = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return out ? `?${out}` : '';
}

let serverDatesAlbums: boolean | null = null;
let fgInFlight = 0;
/** Foreground Jellyfin requests in flight (browsing, polls, commands). */
export function foregroundInFlight(): number {
  return fgInFlight;
}

// ---- 1.4.4: one gate for everything Finch sends over the phone link ----
//
// The Car Thing reaches Jellyfin through the phone's Bluetooth link, a few
// tens of KB/s that every request shares. In 1.4.3 a track change set off
// the session poll, two or three covers, lyrics and (4 s later) the recents
// reload all at once, and the recents reload could be 300 KB; the session
// poll then waited behind it past its 8 s timeout and Finch said it could
// not reach the server. Now:
//   - 'now'  (session polls, playback commands) never waits behind more than
//            two other requests and jumps every queue;
//   - 'normal' (browsing, artwork) runs at most two at a time;
//   - 'low'  (recents refresh, lyrics, the playlist index) only starts when
//            nothing else is running or waiting.
export type Prio = 'now' | 'normal' | 'low';
const PRIO_RANK: Record<Prio, number> = { now: 0, normal: 1, low: 2 };
const MAX_NORMAL = 2;
let linkActive = 0;
const linkQueue: { rank: number; seq: number; go: () => void }[] = [];
let linkSeq = 0;
const linkStats = { started: 0, maxActive: 0, maxQueued: 0 };
function canStart(rank: number): boolean {
  if (rank === 0) return linkActive < MAX_NORMAL + 1;
  if (rank === 1) return linkActive < MAX_NORMAL;
  return linkActive === 0;
}
function pumpLink(): void {
  linkQueue.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  while (linkQueue.length && canStart(linkQueue[0].rank)) {
    const next = linkQueue.shift()!;
    linkActive++;
    next.go();
  }
}
function acquireLink(prio: Prio): Promise<void> {
  const rank = PRIO_RANK[prio];
  // a low request also waits while anything of higher rank is queued
  if (canStart(rank) && !linkQueue.some(q => q.rank <= rank)) {
    linkActive++;
    linkStats.started++;
    linkStats.maxActive = Math.max(linkStats.maxActive, linkActive);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    linkQueue.push({
      rank,
      seq: linkSeq++,
      go: () => {
        linkStats.started++;
        linkStats.maxActive = Math.max(linkStats.maxActive, linkActive);
        resolve();
      },
    });
    linkStats.maxQueued = Math.max(linkStats.maxQueued, linkQueue.length);
  });
}
function releaseLink(): void {
  linkActive--;
  pumpLink();
}
/** Requests on the link or waiting for it (any priority). */
export function linkBusy(): number {
  return linkActive + linkQueue.length;
}
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__finchLink = () => ({ active: linkActive, queued: linkQueue.length, ...linkStats });

export class Jellyfin {
  /** 1.4.4: link priority of this handle's requests (see withPriority). */
  protected prio: Prio = 'normal';

  constructor(
    private readonly client: BridgethingClient,
    readonly creds: Credentials,
  ) {}

  /** The same client whose requests go out at another link priority. */
  withPriority(prio: Prio): Jellyfin {
    if (prio === this.prio) return this;
    const o = Object.create(this) as Jellyfin;
    o.prio = prio;
    return o;
  }

  private async raw(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = 8000,
    background = false,
    prio?: Prio,
  ): Promise<{ status: number; body: Uint8Array; headers: { name: string; value: string }[] }> {
    // 1.4.3: foreground traffic is counted so background work (the playlist
    // index) can stay off the phone link while anything else is using it
    if (!background) fgInFlight++;
    // 1.4.4: the link gate; the request's timeout starts once it is sent
    await acquireLink(background ? 'low' : (prio ?? this.prio));
    try {
      return await this.rawInner(method, path, body, timeoutMs);
    } finally {
      releaseLink();
      if (!background) fgInFlight--;
    }
  }

  private async rawInner(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: Uint8Array; headers: { name: string; value: string }[] }> {
    const headers = [
      { name: 'Authorization', value: authHeader(this.creds.deviceId, this.creds.token) },
      { name: 'X-Emby-Token', value: this.creds.token },
      { name: 'Accept', value: 'application/json' },
    ];
    let payload: Uint8Array | null = null;
    if (body !== undefined) {
      headers.push({ name: 'Content-Type', value: 'application/json' });
      payload = new TextEncoder().encode(JSON.stringify(body));
    } else if (method === 'POST') {
      // some reverse proxies reject a bodyless POST without a length
      payload = new Uint8Array(0);
    }
    const result = await this.client.net.fetch({
      request: {
        url: `${this.creds.serverUrl}${path}`,
        method,
        headers,
        body: payload,
        timeoutMs,
        redirect: 'follow',
      },
    });
    if (!result.ok) {
      const netErr = result.kind === 'domain' ? result.error.error : null;
      const detail = netErr
        ? netErr.type === 'requestFailed'
          ? netErr.data.reason
          : netErr.type === 'noGateway'
            ? 'phone not connected'
            : netErr.type
        : result.kind;
      throw new JellyfinError(`can't reach server (${detail})`);
    }
    const { status, body: resBody, headers: resHeaders } = result.response.response;
    if (status === 401 || status === 403) throw new JellyfinError('sign-in expired, sign in again in settings', status);
    if (status < 200 || status >= 300) throw new JellyfinError(`server returned HTTP ${status}`, status);
    return { status, body: resBody, headers: resHeaders };
  }

  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = new TextDecoder().decode(res.body);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Playback commands: 'now' priority, ahead of browsing and artwork. */
  private post(path: string, body?: unknown): Promise<unknown> {
    return this.raw('POST', path, body, 8000, false, 'now');
  }

  // ---------- library ----------

  private items(params: Record<string, string | number | boolean | undefined>): Promise<Page<Item>> {
    return this.json<Page<Item>>(
      'GET',
      `/Items${qs({
        userId: this.creds.userId,
        Fields: 'ChildCount,PrimaryImageAspectRatio',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        EnableTotalRecordCount: true,
        ...params,
      })}`,
    );
  }

  albums(start = 0, limit = 60, sort: 'SortName' | 'DateCreated' = 'SortName'): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: sort === 'SortName' ? 'SortName' : 'DateCreated,SortName',
      SortOrder: sort === 'SortName' ? 'Ascending' : 'Descending',
      StartIndex: start,
      Limit: limit,
    });
  }

  playlists(start = 0, limit = 60): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'Playlist',
      Fields: 'ChildCount,PrimaryImageAspectRatio,DateLastSaved',
      Recursive: true,
      SortBy: 'SortName',
      StartIndex: start,
      Limit: limit,
    });
  }

  favoriteTracks(start = 0, limit = 100): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'Audio',
      Recursive: true,
      Filters: 'IsFavorite',
      SortBy: 'SortName',
      StartIndex: start,
      Limit: limit,
    });
  }

  // ---- 1.4.3: recents, favorite albums, genres ----

  /** Recently played tracks: the user's play history as the server keeps it
   *  (UserData.LastPlayedDate, set when a player such as Finamp reports a play). */
  recentTracks(start = 0, limit = 60): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'Audio',
      Recursive: true,
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed,SortName',
      SortOrder: 'Descending',
      StartIndex: start,
      Limit: limit,
    });
  }

  /** 1.4.4: play history with only what the recents logic reads (Id, AlbumId,
   *  UserData.LastPlayedDate): no images, no extra fields. */
  recentPlays(start = 0, limit = 100): Promise<Page<Item>> {
    return this.json<Page<Item>>(
      'GET',
      `/Items${qs({
        userId: this.creds.userId,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        Filters: 'IsPlayed',
        SortBy: 'DatePlayed,SortName',
        SortOrder: 'Descending',
        EnableImages: false,
        EnableTotalRecordCount: true,
        StartIndex: start,
        Limit: limit,
      })}`,
    );
  }

  /**
   * Recently played albums. Jellyfin only stamps LastPlayedDate on albums
   * whose own user data was touched, which most players never do, so the
   * server's DatePlayed album sort is used only when it carries real dates;
   * otherwise the albums are taken, in order, from the recent tracks.
   */
  async recentAlbums(limit = 30): Promise<Page<Item>> {
    // 1.4.4: most servers never date albums; once seen, skip that query
    // (a 30-album full page) for the rest of the session
    const server = serverDatesAlbums === false ? null : await this.items({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed,SortName',
      SortOrder: 'Descending',
      Limit: limit,
    }).catch(() => null);
    const dated = server?.Items.filter(a => a.UserData?.LastPlayedDate) ?? [];
    if (dated.length >= Math.min(limit, 3)) {
      serverDatesAlbums = true;
      return { Items: dated, TotalRecordCount: dated.length };
    }
    if (server) serverDatesAlbums = false;
    // 1.4.4: the scan reads lean pages (no images, no extra fields:
    // ~0.45 KB a track instead of ~1.5 KB) of 100, at most 300 tracks;
    // 1.4.3 read up to 3 x 200 full records (~900 KB) on every track change.
    const ids: string[] = [];
    for (let start = 0; start < 300 && ids.length < limit; start += 100) {
      const page = await this.recentPlays(start, 100);
      for (const t of page.Items) if (t.AlbumId && !ids.includes(t.AlbumId)) ids.push(t.AlbumId);
      if (start + page.Items.length >= page.TotalRecordCount || page.Items.length === 0) break;
    }
    const want = ids.slice(0, limit);
    if (!want.length) return { Items: [], TotalRecordCount: 0 };
    const full = await this.items({ Ids: want.join(','), Limit: want.length });
    const byId = new Map(full.Items.map(a => [a.Id, a]));
    const out = want.map(id => byId.get(id)).filter((a): a is Item => !!a);
    return { Items: out, TotalRecordCount: out.length };
  }

  favoriteAlbums(start = 0, limit = 60): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      Filters: 'IsFavorite',
      SortBy: 'SortName',
      StartIndex: start,
      Limit: limit,
    });
  }

  /** Playlists the server says this user played (rare: most players never
   *  stamp playlists). Only entries with a real LastPlayedDate are returned. */
  async playedPlaylists(limit = 30): Promise<Item[]> {
    const page = await this.items({
      IncludeItemTypes: 'Playlist',
      Recursive: true,
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed,SortName',
      SortOrder: 'Descending',
      Limit: limit,
    });
    return page.Items.filter(p => p.UserData?.LastPlayedDate);
  }

  /** Every playlist with just what tells whether it changed (one request, no images). */
  async playlistSigs(): Promise<{ items: Item[]; bytes: number }> {
    const res = await this.raw(
      'GET',
      `/Items${qs({
        userId: this.creds.userId,
        IncludeItemTypes: 'Playlist',
        Recursive: true,
        Fields: 'ChildCount,DateLastSaved',
        EnableImages: false,
        EnableUserData: false,
        EnableTotalRecordCount: false,
        Limit: 2000,
      })}`,
      undefined,
      15_000,
      true,
    );
    const page = JSON.parse(new TextDecoder().decode(res.body)) as Page<Item>;
    return { items: page.Items ?? [], bytes: res.body.length };
  }

  /**
   * All track ids of a playlist in one small response: Jellyfin 10.9+
   * GET /Playlists/{id} returns a PlaylistDto with ItemIds (ids only, ~40
   * bytes per track). Null when the server has no such route (older
   * servers): the caller falls back to playlistItemIds pages.
   */
  async playlistIdsOnly(playlistId: string): Promise<{ ids: string[]; bytes: number } | null> {
    try {
      const res = await this.raw('GET', `/Playlists/${playlistId}`, undefined, 15_000, true);
      const dto = JSON.parse(new TextDecoder().decode(res.body)) as { ItemIds?: string[] };
      return Array.isArray(dto?.ItemIds) ? { ids: dto.ItemIds, bytes: res.body.length } : null;
    } catch (err) {
      if (err instanceof JellyfinError && err.status !== null && err.status !== 401 && err.status !== 403) return null;
      throw err;
    }
  }

  /** One small page of a playlist's track ids (for the playlist index): no
   *  images, no user data, background priority. Jellyfin has no ids-only
   *  route, so each entry is still a small item record. */
  async playlistItemIds(
    playlistId: string,
    start = 0,
    limit = 100,
  ): Promise<{ ids: string[]; total: number; bytes: number }> {
    const res = await this.raw(
      'GET',
      `/Playlists/${playlistId}/Items${qs({
        userId: this.creds.userId,
        StartIndex: start,
        Limit: limit,
        EnableImages: false,
        EnableUserData: false,
        EnableTotalRecordCount: true,
      })}`,
      undefined,
      15_000,
      true,
    );
    const page = JSON.parse(new TextDecoder().decode(res.body)) as Page<Item>;
    const ids = (page.Items ?? []).map(it => it.Id);
    return { ids, total: page.TotalRecordCount ?? start + ids.length, bytes: res.body.length };
  }

  /** First track of a playlist (its album art stands in for a missing cover). */
  async playlistFirstTrack(playlistId: string): Promise<Item | null> {
    const page = await this.json<Page<Item>>(
      'GET',
      `/Playlists/${playlistId}/Items${qs({ userId: this.creds.userId, Limit: 1, EnableImageTypes: 'Primary', ImageTypeLimit: 1 })}`,
    );
    return page?.Items?.[0] ?? null;
  }

  private musicLib: Promise<string | null> | null = null;
  /** The user's music library, when there is exactly one (scopes genres to it). */
  private musicLibrary(): Promise<string | null> {
    this.musicLib ??= this.json<Page<Item & { CollectionType?: string }>>(
      'GET',
      `/UserViews${qs({ userId: this.creds.userId })}`,
    ).then(
      v => {
        const music = (v?.Items ?? []).filter(x => x.CollectionType === 'music');
        return music.length === 1 ? music[0].Id : null;
      },
      () => {
        this.musicLib = null;
        return null;
      },
    );
    return this.musicLib;
  }

  /** Music genres, paged. Genres without a picture borrow one album's cover
   *  (one extra request per page, albums filtered by all the page's genres). */
  async genres(start = 0, limit = 60): Promise<Page<Item>> {
    const parentId = await this.musicLibrary();
    const page = await this.json<Page<Item>>(
      'GET',
      `/MusicGenres${qs({
        userId: this.creds.userId,
        ParentId: parentId ?? undefined,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        StartIndex: start,
        Limit: limit,
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        EnableTotalRecordCount: true,
      })}`,
    );
    const items = (page?.Items ?? []).map(g => ({ ...g, Type: 'MusicGenre' }));
    const bare = items.filter(g => !g.ImageTags?.Primary);
    if (bare.length) {
      try {
        const albums = await this.items({
          IncludeItemTypes: 'MusicAlbum',
          Recursive: true,
          GenreIds: bare.map(g => g.Id).join('|'),
          Fields: 'GenreItems',
          SortBy: 'SortName',
          Limit: 300,
        });
        for (const g of bare) {
          const a = albums.Items.find(x => x.ImageTags?.Primary && x.GenreItems?.some(gi => gi.Id === g.Id));
          if (a) Object.assign(g, { AlbumId: a.Id, AlbumPrimaryImageTag: a.ImageTags!.Primary });
        }
      } catch {
        /* placeholders it is */
      }
    }
    return { Items: items, TotalRecordCount: page?.TotalRecordCount ?? items.length };
  }

  genreAlbums(genreId: string, start = 0, limit = 60): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      GenreIds: genreId,
      SortBy: 'SortName',
      StartIndex: start,
      Limit: limit,
    });
  }

  /** Tracks of a genre, album by album (capped: Play sends at most 150 anyway). */
  genreTracks(genreId: string, limit = 300): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'Audio',
      Recursive: true,
      GenreIds: genreId,
      SortBy: 'AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName',
      Limit: limit,
    });
  }

  artists(start = 0, limit = 60): Promise<Page<Item>> {
    return this.json<Page<Item>>(
      'GET',
      `/Artists/AlbumArtists${qs({
        userId: this.creds.userId,
        SortBy: 'SortName',
        StartIndex: start,
        Limit: limit,
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        Fields: 'ChildCount',
      })}`,
    );
  }

  artistAlbums(artistId: string): Promise<Page<Item>> {
    return this.items({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      AlbumArtistIds: artistId,
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      Limit: 200,
    });
  }

  /** Tracks of an album or playlist, in play order. */
  async tracks(parent: Item): Promise<Item[]> {
    if (parent.Type === 'Playlist') {
      const page = await this.json<Page<Item>>(
        'GET',
        `/Playlists/${parent.Id}/Items${qs({ userId: this.creds.userId, Limit: 500, Fields: 'ChildCount' })}`,
      );
      return page.Items;
    }
    const page = await this.items({
      ParentId: parent.Id,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'ParentIndexNumber,IndexNumber,SortName',
      Limit: 500,
    });
    return page.Items;
  }

  async instantMix(itemId: string): Promise<Item[]> {
    const page = await this.json<Page<Item>>(
      'GET',
      `/Items/${itemId}/InstantMix${qs({ userId: this.creds.userId, Limit: 100 })}`,
    );
    return page.Items;
  }

  async setFavorite(itemId: string, favorite: boolean): Promise<void> {
    await this.raw(favorite ? 'POST' : 'DELETE', `/UserFavoriteItems/${itemId}${qs({ userId: this.creds.userId })}`);
  }

  /** Artwork bytes for an item (falls back to its album's art for tracks). */
  async image(item: Item, size: number): Promise<{ bytes: Uint8Array; mime: string } | null> {
    let id = item.Id;
    let tag = item.ImageTags?.Primary;
    if (!tag && item.AlbumId && item.AlbumPrimaryImageTag) {
      id = item.AlbumId;
      tag = item.AlbumPrimaryImageTag;
    }
    if (!tag) return null;
    try {
      const res = await this.raw(
        'GET',
        `/Items/${id}/Images/Primary${qs({ fillHeight: size, fillWidth: size, quality: 85, tag })}`,
        undefined,
        10_000,
      );
      if (res.body.length === 0) return null;
      const mime = res.headers.find(h => h.name.toLowerCase() === 'content-type')?.value.split(';')[0] ?? 'image/jpeg';
      return { bytes: res.body, mime };
    } catch {
      return null;
    }
  }

  /**
   * Lyrics for a track (Jellyfin 10.9+ `/Audio/{id}/Lyrics`, falling back to the
   * 10.8 per-user route). Null when the track has none.
   */
  async lyrics(itemId: string): Promise<Lyrics | null> {
    type Raw = { Lyrics?: { Text?: string; Start?: number | null }[] };
    let raw: Raw | null = null;
    for (const path of [`/Audio/${itemId}/Lyrics`, `/Users/${this.creds.userId}/Items/${itemId}/Lyrics`]) {
      try {
        raw = await this.json<Raw>('GET', path);
        break;
      } catch (err) {
        if (err instanceof JellyfinError && (err.status === 404 || err.status === 400)) continue;
        throw err;
      }
    }
    const list = raw?.Lyrics ?? [];
    const lines = list
      .map(l => ({ text: (l.Text ?? '').trim(), startMs: l.Start != null ? l.Start / TICKS_PER_MS : null }))
      .filter((l, i, all) => l.text !== '' || (i > 0 && all[i - 1].text !== ''));
    if (!lines.some(l => l.text)) return null;
    const synced = lines.filter(l => l.startMs != null).length >= Math.max(2, lines.length * 0.6);
    return { lines, synced };
  }

  // ---------- sessions (remote control) ----------

  // Server clock offset (server - local, ms), narrowed from the HTTP Date header.
  // Date has 1 s resolution, so each response bounds the offset to a window;
  // intersecting windows across polls converges on the true value.
  private sightings = new Map<string, { ticks: number; item?: string; playing: boolean; seenAt: number }>();
  private clockLo = -Infinity;
  private clockHi = Infinity;

  private noteClock(dateHeader: string | undefined, sentAt: number, recvAt: number) {
    const d = dateHeader ? Date.parse(dateHeader) : NaN;
    if (!Number.isFinite(d)) return;
    // the server stamped Date somewhere between sentAt and recvAt, floored to the second
    const lo = d - recvAt;
    const hi = d + 1000 - sentAt;
    if (lo > this.clockHi || hi < this.clockLo) {
      // clocks jumped (NTP sync, sleep): start over
      this.clockLo = lo;
      this.clockHi = hi;
    } else {
      this.clockLo = Math.max(this.clockLo, lo);
      this.clockHi = Math.min(this.clockHi, hi);
    }
  }

  async sessions(): Promise<Session[]> {
    const sentAt = Date.now();
    const res = await this.raw(
      'GET',
      `/Sessions${qs({ ControllableByUserId: this.creds.userId, ActiveWithinSeconds: 960 })}`,
      undefined,
      8000,
      false,
      'now',
    );
    const recvAt = Date.now();
    this.noteClock(res.headers.find(h => h.name.toLowerCase() === 'date')?.value, sentAt, recvAt);
    const list = JSON.parse(new TextDecoder().decode(res.body)) as Session[];
    // the request took (recvAt - sentAt); the server read the session about halfway
    const readAt = (sentAt + recvAt) / 2;
    return list
      .filter(s => s.SupportsRemoteControl && s.DeviceId !== this.creds.deviceId)
      .map(s => {
        const ps = s.PlayState ?? {};
        const ticks = ps.PositionTicks ?? 0;
        const playing = !!s.NowPlayingItem && !ps.IsPaused;
        // Some players report progress rarely (Finamp: every 150 s by default,
        // plus on play/pause/seek/track change), others constantly. Anchor the
        // reported position to the first poll that saw it: a live reporter
        // changes it every poll (no extrapolation), a sparse one gets rolled
        // forward from when we first saw the value. No clock maths involved.
        const key = s.Id;
        const prev = this.sightings.get(key);
        const same = prev && prev.ticks === ticks && prev.item === s.NowPlayingItem?.Id && prev.playing === playing;
        const seenAt = same ? prev.seenAt : readAt;
        this.sightings.set(key, { ticks, item: s.NowPlayingItem?.Id, playing, seenAt });
        const pos = ticks / TICKS_PER_MS + (playing ? readAt - seenAt : 0);
        return { ...s, positionMs: pos, positionAt: readAt };
      });
  }

  playNow(sessionId: string, ids: string[], startIndex = 0): Promise<unknown> {
    return this.post(
      `/Sessions/${sessionId}/Playing${qs({ playCommand: 'PlayNow', itemIds: ids.join(','), startIndex })}`,
    );
  }

  queue(sessionId: string, ids: string[], next: boolean): Promise<unknown> {
    return this.post(
      `/Sessions/${sessionId}/Playing${qs({ playCommand: next ? 'PlayNext' : 'PlayLast', itemIds: ids.join(',') })}`,
    );
  }

  command(
    sessionId: string,
    cmd: 'PlayPause' | 'Pause' | 'Unpause' | 'NextTrack' | 'PreviousTrack' | 'Stop',
  ): Promise<unknown> {
    return this.post(`/Sessions/${sessionId}/Playing/${cmd}`);
  }

  seek(sessionId: string, positionMs: number): Promise<unknown> {
    return this.post(
      `/Sessions/${sessionId}/Playing/Seek${qs({ seekPositionTicks: Math.max(0, Math.round(positionMs * TICKS_PER_MS)) })}`,
    );
  }

  setShuffle(sessionId: string, shuffle: boolean): Promise<unknown> {
    return this.post(`/Sessions/${sessionId}/Command`, {
      Name: 'SetShuffleQueue',
      Arguments: { ShuffleMode: shuffle ? 'Shuffle' : 'Sorted' },
    });
  }

  setRepeat(sessionId: string, mode: 'RepeatNone' | 'RepeatAll' | 'RepeatOne'): Promise<unknown> {
    return this.post(`/Sessions/${sessionId}/Command`, { Name: 'SetRepeatMode', Arguments: { RepeatMode: mode } });
  }

  async serverName(): Promise<string> {
    const info = await this.json<{ ServerName?: string }>('GET', '/System/Info/Public');
    return info?.ServerName ?? 'Jellyfin';
  }
}

export function artistLine(item: Item): string {
  if (item.Type === 'MusicAlbum') return item.AlbumArtist ?? item.Artists?.join(', ') ?? '';
  if (item.Type === 'Playlist') return item.ChildCount != null ? `${item.ChildCount} track${item.ChildCount === 1 ? '' : 's'}` : 'Playlist';
  if (item.Type === 'MusicArtist') return item.ChildCount != null ? `${item.ChildCount} album${item.ChildCount === 1 ? '' : 's'}` : 'Artist';
  return item.Artists?.join(', ') || item.AlbumArtist || '';
}

export function shuffled<T>(list: T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

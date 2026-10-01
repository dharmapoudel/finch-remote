// Remote control of another Jellyfin client's session. Jellyfin's server
// API lets one client drive another client's session (the same mechanism
// as "Play on" in Jellyfin Web); most music clients implement the
// receiving end — Finamp via its PlayOn websocket service (on by default),
// Jellyfin Web / Swiftfin natively. In remote mode Finch is only the
// remote: audio, queue and lock-screen metadata all live in the other
// client. The remote track is mirrored into the player's queue/index/clock
// so every view works unchanged.

import { JellyfinClient, type RawSession, type Track } from './jellyfin';

export interface RemoteSessionInfo {
  id: string;
  client: string;
  deviceName: string;
  nowPlayingName: string | null;
  isPlaying: boolean;
  lastActive: string | null;
  /** Not currently advertised by the server — the last-used session, shown
   *  greyed out so a suspended client reads as "offline" rather than lost. */
  offline?: boolean;
}

export type RemoteCommand = 'Pause' | 'Unpause' | 'NextTrack' | 'PreviousTrack' | 'Seek' | 'Stop';

export interface RemoteState {
  track: Track | null;
  positionMs: number;
  paused: boolean;
  client: string;
  deviceName: string;
}

function normalizeRemoteTrack(raw: NonNullable<RawSession['NowPlayingItem']>): Track {
  return {
    id: raw.Id,
    name: raw.Name ?? 'Unknown track',
    albumId: raw.AlbumId ?? null,
    album: raw.Album ?? '',
    artist: (raw.Artists ?? []).join(', '),
    durationMs: Math.round((raw.RunTimeTicks ?? 0) / 10_000),
    isFavorite: raw.UserData?.IsFavorite ?? false,
    playCount: 0,
    imageTag: raw.ImageTags?.Primary ?? raw.AlbumPrimaryImageTag ?? null,
    albumImageTag: raw.AlbumPrimaryImageTag ?? null,
  };
}

export class RemoteControl {
  constructor(private jf: JellyfinClient) {}

  /** Sessions this Jellyfin user can drive, most recently active first.
   *  Finch's own session is excluded — it must never remote-control itself. */
  async discover(): Promise<RemoteSessionInfo[]> {
    const sessions = await this.jf.rawSessions();
    return sessions
      .filter(s => (s.Client ?? '').toLowerCase() !== 'finch')
      .map(s => ({
        id: s.Id,
        client: s.Client || 'Player',
        deviceName: s.DeviceName || 'Phone',
        nowPlayingName: s.NowPlayingItem?.Name ?? null,
        isPlaying: !!s.NowPlayingItem && !(s.PlayState?.IsPaused ?? true),
        lastActive: s.LastActivityDate ?? null,
      }))
      .sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
  }

  /** Current state of one session; null when it is gone (client closed). */
  async state(sessionId: string): Promise<RemoteState | null> {
    const sessions = await this.jf.rawSessions();
    const s = sessions.find(x => x.Id === sessionId);
    if (!s) return null;
    const item = s.NowPlayingItem;
    return {
      track: item ? normalizeRemoteTrack(item) : null,
      positionMs: Math.round((s.PlayState?.PositionTicks ?? 0) / 10_000),
      paused: s.PlayState?.IsPaused ?? true,
      client: s.Client || 'Player',
      deviceName: s.DeviceName || 'Phone',
    };
  }

  /** Lighter state check for the track-switch polls: fetches just this
   *  session instead of the full list. */
  async stateOne(sessionId: string): Promise<RemoteState | null> {
    const s = await this.jf.rawSession(sessionId);
    if (!s) return null;
    const item = s.NowPlayingItem;
    return {
      track: item ? normalizeRemoteTrack(item) : null,
      positionMs: Math.round((s.PlayState?.PositionTicks ?? 0) / 10_000),
      paused: s.PlayState?.IsPaused ?? true,
      client: s.Client || 'Player',
      deviceName: s.DeviceName || 'Phone',
    };
  }

  command(sessionId: string, cmd: RemoteCommand, seekMs?: number): Promise<void> {
    const body: Record<string, unknown> = { Command: cmd };
    if (cmd === 'Seek' && seekMs !== undefined) body.SeekPositionTicks = Math.round(seekMs * 10_000);
    return this.jf.remotePlaystate(sessionId, cmd, body);
  }

  /** Start playback of items on the remote session; the client builds its
   *  own queue from the item ids. */
  playNow(sessionId: string, itemIds: string[], startIndex = 0): Promise<void> {
    return this.jf.remotePlay(sessionId, itemIds, startIndex);
  }
}

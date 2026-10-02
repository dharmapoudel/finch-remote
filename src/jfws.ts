// Persistent WebSocket to Jellyfin's /socket through the phone companion.
// The server pushes `Sessions` messages when any session's state changes,
// so Finch learns about remote track switches instantly instead of polling.
//
// Auth: header-based (`Authorization: MediaBrowser Token="..."`) plus the
// `deviceId` query param. The token alone (no deviceId) gets keepalives but
// no session data — the server can't associate the socket with a session.
// Verified against Jellyfin 12.1.0 2026-10-01.

import { getClient } from './client';
import { finchDeviceId } from './jellyfin';

export interface WsRemoteState {
  trackId: string | null;
  trackName: string | null;
  albumId: string | null;
  album: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  paused: boolean;
  isFavorite: boolean;
  imageTag: string | null;
  albumImageTag: string | null;
}

function normalizeWsTrack(item: any): WsRemoteState | null {
  if (!item) return null;
  return {
    trackId: item.Id ?? null,
    trackName: item.Name ?? 'Unknown track',
    albumId: item.AlbumId ?? null,
    album: item.Album ?? '',
    artist: (item.Artists ?? []).join(', '),
    durationMs: Math.round((item.RunTimeTicks ?? 0) / 10_000),
    positionMs: 0, // filled from PlayState by the caller
    paused: true,
    isFavorite: item.UserData?.IsFavorite ?? false,
    imageTag: item.ImageTags?.Primary ?? item.AlbumPrimaryImageTag ?? null,
    albumImageTag: item.AlbumPrimaryImageTag ?? null,
  };
}

export class JellyfinSocket {
  private connectionId: string | null = null;
  private unsubs: (() => void)[] = [];
  private keepAliveTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  private reconnectDelay = 2000;

  /** Called with the raw session list on every `Sessions` push. */
  onSessions: ((sessions: any[]) => void) | null = null;
  /** Called when the socket drops (for fallback/reconnect UI). */
  onClose: (() => void) | null = null;

  get isOpen(): boolean {
    return this.connectionId !== null;
  }

  async connect(serverUrl: string, token: string): Promise<void> {
    this.closed = false;
    this.reconnectDelay = 2000;
    await this.open(serverUrl, token);
  }

  private async open(serverUrl: string, token: string): Promise<void> {
    if (this.closed) return;
    const client = getClient();
    const deviceId = await finchDeviceId();
    const connectionId = crypto.randomUUID();

    const offMsg = client.net.onWsMessage(msg => {
      if (msg.connectionId !== connectionId || msg.frame.type !== 'text') return;
      this.handleMessage(msg.frame.data);
    });
    const offClosed = client.net.onWsClosed(msg => {
      if ((msg as any).connectionId !== connectionId) return;
      this.handleDrop();
    });
    const offErr = client.net.onWsErrorEvent(() => {
      this.handleDrop();
    });
    this.unsubs = [offMsg, offClosed, offErr];

    const wsUrl = serverUrl.replace(/^http/, 'ws') + `/socket?deviceId=${encodeURIComponent(deviceId)}`;
    let result;
    try {
      result = await client.net.wsOpen(
        {
          connectionId,
          url: wsUrl,
          protocols: null,
          headers: [{ name: 'Authorization', value: `MediaBrowser Token="${token}"` }],
        },
        { timeoutMs: 12000 },
      );
    } catch {
      this.handleDrop();
      return;
    }
    if (!result.ok) {
      this.handleDrop();
      return;
    }

    this.connectionId = connectionId;
    // Subscribe to session pushes. Data "0,1500" = initial dump (start 0, take 1500).
    await client.net
      .wsSend({
        connectionId,
        frame: { type: 'text', data: JSON.stringify({ MessageType: 'SessionsStart', Data: '0,1500' }) },
      })
      .catch(() => this.handleDrop());

    // Answer ForceKeepAlive (~48s) so the server doesn't mark us lost at 60s.
    if (this.keepAliveTimer !== null) window.clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = window.setInterval(() => {
      if (this.connectionId) {
        void client.net
          .wsSend({
            connectionId: this.connectionId,
            frame: { type: 'text', data: JSON.stringify({ MessageType: 'KeepAlive' }) },
          })
          .catch(() => {});
      }
    }, 30000);
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.MessageType === 'Sessions' && Array.isArray(msg.Data)) {
      this.onSessions?.(msg.Data);
    }
    // ForceKeepAlive is answered by the 30s interval; nothing to do here.
  }

  private handleDrop(): void {
    if (this.connectionId) {
      const cid = this.connectionId;
      this.connectionId = null;
      try {
        void getClient().net.wsClose({ connectionId: cid, code: 1000, reason: 'client close' }).catch(() => {});
      } catch {
        // ignore
      }
    }
    this.unsubs.forEach(u => {
      try {
        u();
      } catch {
        // ignore
      }
    });
    this.unsubs = [];
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.onClose?.();
    // Reconnect with backoff unless explicitly closed.
    if (!this.closed) {
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        // The caller re-connects via player.ts (it holds serverUrl/token).
        this.onClose?.();
      }, delay);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.handleDrop();
  }
}

/** Extract the remote session's state from a `Sessions` push. */
export function findRemoteState(sessions: any[], sessionId: string): WsRemoteState | null {
  const s = sessions.find(x => x?.Id === sessionId);
  if (!s) return null;
  const st = normalizeWsTrack(s.NowPlayingItem);
  if (!st) return null;
  st.positionMs = Math.round(((s.PlayState?.PositionTicks ?? 0) as number) / 10_000);
  st.paused = (s.PlayState?.IsPaused as boolean) ?? true;
  return st;
}

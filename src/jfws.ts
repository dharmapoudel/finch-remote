// WebSocket to Jellyfin's /socket through the phone companion, used
// ON-DEMAND: the socket stays open, but we only subscribe to `Sessions`
// pushes when we need an update (after a remote command). This avoids the
// constant 15KB background flood that drops the Bluetooth link.
//
// Auth: header-based (`Authorization: MediaBrowser Token="..."`) plus the
// `deviceId` query param. Verified against Jellyfin 12.1.0 2026-10-01.

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
    positionMs: 0,
    paused: true,
    isFavorite: item.UserData?.IsFavorite ?? false,
    imageTag: item.ImageTags?.Primary ?? item.AlbumPrimaryImageTag ?? null,
    albumImageTag: item.AlbumPrimaryImageTag ?? null,
  };
}

export function findRemoteState(sessions: any[], sessionId: string): WsRemoteState | null {
  const s = sessions.find(x => x?.Id === sessionId);
  if (!s) return null;
  const st = normalizeWsTrack(s.NowPlayingItem);
  if (!st) return null;
  st.positionMs = Math.round(((s.PlayState?.PositionTicks ?? 0) as number) / 10_000);
  st.paused = (s.PlayState?.IsPaused as boolean) ?? true;
  return st;
}

export class JellyfinSocket {
  private connectionId: string | null = null;
  private unsubs: (() => void)[] = [];
  private keepAliveTimer: number | null = null;
  private closed = false;
  private pendingResolve: ((sessions: any[] | null) => void) | null = null;
  private pendingTimer: number | null = null;
  private subCallback: ((sessions: any[]) => void) | null = null;

  get isOpen(): boolean {
    return this.connectionId !== null;
  }

  /** Open the socket (no subscription yet). Idempotent. */
  async connect(serverUrl: string, token: string): Promise<void> {
    if (this.connectionId || this.closed) return;
    const client = getClient();
    const deviceId = await finchDeviceId();
    const connectionId = crypto.randomUUID();

    const offMsg = client.net.onWsMessage(msg => {
      if (msg.connectionId !== connectionId || msg.frame.type !== 'text') return;
      this.handleMessage(msg.frame.data);
    });
    const offClosed = client.net.onWsClosed(msg => {
      if (msg.connectionId !== connectionId) return;
      this.handleDrop();
    });
    const offErr = client.net.onWsErrorEvent(msg => {
      if (msg.connectionId !== connectionId) return;
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
      this.cleanup();
      throw new Error('wsOpen failed');
    }
    if (!result.ok) {
      this.cleanup();
      throw new Error('wsOpen rejected');
    }

    this.connectionId = connectionId;
    // Keepalive so the server doesn't mark us lost (ForceKeepAlive ~48s).
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

  /**
   * Persistent subscription: server pushes `Sessions` on every state change.
   * The callback fires for each push. Call unsubscribeSessions() to stop.
   * Unlike requestSessions (one-shot), this stays subscribed — used by the
   * Now Playing screen for instant bidirectional updates without polling.
   */
  subscribeSessions(cb: (sessions: any[]) => void): void {
    if (!this.connectionId) return;
    this.subCallback = cb;
    void this.send({ MessageType: 'SessionsStart', Data: '0,1500' }).catch(() => {});
  }

  unsubscribeSessions(): void {
    this.subCallback = null;
    // Don't send SessionsStop if a one-shot request is in flight — it will
    // stop itself. Otherwise stop the persistent subscription.
    if (!this.pendingResolve) {
      void this.send({ MessageType: 'SessionsStop' }).catch(() => {});
    }
  }

  /**
   * Request one `Sessions` push. Subscribes, waits for the next push (or
   * timeout), then unsubscribes. Resolves with the session list, or null on
   * timeout/failure (caller falls back to HTTP poll).
   */
  async requestSessions(timeoutMs = 2500): Promise<any[] | null> {
    if (!this.connectionId || this.pendingResolve) return null;

    return new Promise(resolve => {
      this.pendingResolve = resolve;
      this.pendingTimer = window.setTimeout(() => {
        this.pendingTimer = null;
        const r = this.pendingResolve;
        this.pendingResolve = null;
        void this.send({ MessageType: 'SessionsStop' }).catch(() => {});
        r?.(null);
      }, timeoutMs);
      void this.send({ MessageType: 'SessionsStart', Data: '0,1500' }).catch(() => {
        if (this.pendingTimer !== null) {
          window.clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        const r = this.pendingResolve;
        this.pendingResolve = null;
        r?.(null);
      });
    });
  }

  private async send(msg: Record<string, unknown>): Promise<void> {
    if (!this.connectionId) return;
    await getClient().net.wsSend({
      connectionId: this.connectionId,
      frame: { type: 'text', data: JSON.stringify(msg) },
    });
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.MessageType === 'Sessions' && Array.isArray(msg.Data)) {
      // Persistent subscriber (Now Playing bidirectional sync) gets every push.
      this.subCallback?.(msg.Data);
      // One-shot requester gets the first push, then we unsubscribe.
      if (this.pendingResolve) {
        if (this.pendingTimer !== null) {
          window.clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        const r = this.pendingResolve;
        this.pendingResolve = null;
        // Unsubscribe immediately: we got what we came for — unless a
        // persistent subscriber is active, in which case stay subscribed.
        if (!this.subCallback) {
          void this.send({ MessageType: 'SessionsStop' }).catch(() => {});
        }
        r(msg.Data);
      }
    }
  }

  private handleDrop(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r(null);
    }
    if (this.connectionId) {
      const cid = this.connectionId;
      this.connectionId = null;
      try {
        void getClient().net.wsClose({ connectionId: cid, code: 1000, reason: 'cleanup' }).catch(() => {});
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
  }

  close(): void {
    this.closed = true;
    this.cleanup();
  }
}

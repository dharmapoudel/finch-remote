// Playback engine. The phone's stream provider only understands
// play/pause/resume/seekTo on a raw http(s) uri, so Finch keeps its OWN
// queue (tracks + index + repeat/shuffle) and calls play() per track.
// Snapshots from the daemon drive state; the progress bar extrapolates
// locally between them.

import { getClient } from './client';
import { JellyfinClient, JellyfinError, type Track } from './jellyfin';
import { RemoteControl, type RemoteSessionInfo, type RemoteState } from './remote';

export type RepeatMode = 'off' | 'all' | 'one';

const CONTEXT_PREFIX = 'finch:track:';
const RESUME_KEY = 'finch:resume';
const DEVICE_ID_KEY = 'finch:device-id';
const PROGRESS_REPORT_MS = 30_000;
const PLAY_GRACE_MS = 1500;
// Pause travels app -> daemon -> Bluetooth -> phone, so snapshots taken
// before it lands still say "playing". While this window is open after a
// user-initiated pause, stale snapshots must not resurrect intentPlaying
// (which flips the UI back, keeps the lyrics moving, and can let a
// transient "stopped" misfire next() and restart audio).
const PAUSE_GRACE_MS = 2000;
// When the phone's Bluetooth link drops and comes back, the phone often
// restarts the current track from the beginning while our clock kept
// ticking (the seek bar "continues as normal" but the audio restarted).
// On a genuine reconnect we push the phone back to where the music was.
const RECONNECT_HEAL_MIN_MS = 15_000; // only heal when we're well into the track
const RECONNECT_SETTLE_MS = 2500; // let the phone finish restarting first
const RECONNECT_WATCH_MS = 10_000; // watch post-reconnect snapshots for a late restart
const RESTART_GAP_MS = 10_000; // phone this far behind us => it restarted
// The daemon rate-limits player.seekTo (every call crosses the Bluetooth
// link): pace the phone-bound sends so scrubbing can never trip
// "Rate limit exceeded". The local clock updates instantly; only the send
// is paced, trailing-edge, so a flurry of seeks collapses into one.
const SEEK_PACE_MS = 800;
// End-of-track detection. The phone does not always report "stopped" when
// a track ends — some companions surface it as "paused at the duration",
// others keep saying "playing" while parked at the cap. END_EPS_MS is how
// close to the duration a "paused" snapshot must be to count as the natural
// end; the watchdog below re-checks every END_WATCH_MS as a backstop.
const END_EPS_MS = 2000;
const END_WATCH_MS = 5000;
// How close to the end (by our clock) before we start polling the phone
// directly instead of waiting for its end-of-track snapshot.
const END_POLL_WINDOW_MS = 10_000;
// Pause-yield: the companion never releases the iOS audio session on pause
// (its keepalive re-asserts exclusive every ~10s), so a pause that idles
// this long gets "abandoned" — we play the track at its very end so the
// companion sees a natural end and yields the session. Short pauses are
// untouched; resume always works with one tap from the saved position.
const ABANDON_AFTER_PAUSE_MS = 60_000;
// Phone-side pause (interruption, another app took the iPhone's audio
// session, or a pause from lock screen / BT controls): the iOS companion
// keeps the session exclusive while its stream is paused — and re-asserts
// it on every Bluetooth reconnect — so every second we wait is another
// second the user's other iPhone audio stays blocked. Yield fast here;
// resume is still one tap from the saved position.
const ABANDON_AFTER_PHONE_PAUSE_MS = 15_000;
// Remote mode: server session polls. Position only needs to be
// fresh enough for the progress bar; commands are instant.
// Remote-mode poll: a steady drip of tiny /Sessions reads keeps Finch in
// The remote poll keeps our mirror of Finamp's state honest and doubles as
// the link-drop detector (3 consecutive transport failures = link down).
// Adaptive cadence: 15s while music is playing (progress + track changes),
// 60s when idle — polling into a quiet or struggling Bluetooth link is
// exactly the kind of background traffic that keeps it from recovering.
// The poll is also paused entirely while the phone link is down.
// 10s was the fastest network poll of any Bridgething app (next: 5 min).
const REMOTE_POLL_PLAYING_MS = 15000;
const REMOTE_POLL_IDLE_MS = 60000;
// After we send a remote command our optimistic local state wins over poll
// data for this long, so the UI doesn't flicker back mid-flight.
const REMOTE_CMD_SETTLE_MS = 2000;
// Persisted remote session (auto re-attach on app restart).
const REMOTE_KEY = 'finch:remote-session';

export interface PersistedQueue {
  tracks: Track[];
  index: number;
  positionMs: number;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class PlaybackEngine {
  private jf: JellyfinClient | null = null;
  private deviceId = '';
  private listeners = new Set<() => void>();

  queue: Track[] = [];
  index = -1;
  intentPlaying = false;
  loading = false;
  error: string | null = null;
  // the phone's own words for the failure (playFailed reason), shown small
  // under the friendly message. Cleared wherever error is cleared.
  errorDetail: string | null = null;
  external = false;
  shuffle = false;
  repeat: RepeatMode = 'off';
  // Lyrics tab is a sticky preference: on across track changes AND across
  // app restarts (persisted in finch:prefs with shuffle/repeat).
  lyricsTab = false;
  volume: number | null = null;
  muted = false;
  private rev = 0;

  private positionMs = 0;
  private positionAt = 0;
  private durationMs = 0;
  private awaitingStart = false;
  private lastPlayAt = 0;
  private sessionId = '';
  private progressTimer: number | null = null;
  private endWatchTimer: number | null = null;
  private lastPauseAt = 0;
  private lastSeekSentAt = 0;
  private lastSeekTargetMs: number | null = null;
  private pendingSeekMs: number | null = null;
  private seekSendTimer: number | null = null;
  // Every playAt() bumps this; async completions from a superseded play
  // (rapid next/prev, or auto-advance racing a manual skip) must not touch
  // state once a newer play started. Finamp's robustness comes from skip
  // being a single idempotent command on one persistent player; the closest
  // Finch gets over the Bluetooth link is serializing plays like this.
  private playGen = 0;
  // latest daemon snapshot, for resume reconciliation after an app restart
  private snapSeen = false;
  private snapTrackId: string | null = null;
  private snapPlaying = false;
  private snapPositionMs = 0;
  private lastSnapAt = 0;
  private adopting: string | null = null;
  // gateway (phone Bluetooth) link state, fed by client.peer.onSnapshot
  private gatewayUp: boolean | null = null;
  private healTimer: number | null = null;
  private lastReconnectAt = 0;
  // Bumped on every genuine link transition (drop or reconnect). Views use
  // it to retry loads that failed mid-outage once the link is back.
  private linkGen = 0;
  private linkListeners = new Set<() => void>();
  // Remote mode: Finch becomes a remote control for another
  // Jellyfin client's session on the server. The remote track is mirrored
  // into queue/index/intentPlaying/position so every view works unchanged;
  // transport methods route to the server instead of the companion.
  remoteSessionId: string | null = null;
  remoteClient = '';
  remoteDevice = '';
  private remotePollTimer: number | null = null;
  private lastArmedPlaying: boolean | null = null;

  // (Re)start the remote poll at the cadence matching the current play
  // state. Called on attach, reconnect, play/pause flips, and whenever the
  // poll itself observes a state change.
  private armRemotePoll(): void {
    if (this.remotePollTimer !== null) window.clearInterval(this.remotePollTimer);
    const playing = this.intentPlaying;
    this.lastArmedPlaying = playing;
    this.remotePollTimer = window.setInterval(
      () => void this.pollRemote(),
      playing ? REMOTE_POLL_PLAYING_MS : REMOTE_POLL_IDLE_MS,
    );
  }
  private remoteGen = 0;
  private lastRemoteCmdAt = 0;
  // True while the phone Bluetooth link is known down: remote mode is kept
  // (the user picked it) but commands short-circuit with 'The phone link
  // dropped.' instead of failing confusingly, until the link recovers.
  private remoteLinkDown = false;
  // Consecutive poll transport failures; the backstop for link drops the
  // gateway snapshot feed doesn't report.
  private remoteTransportFails = 0;
  // Pause-yield abandon (see ABANDON_AFTER_PAUSE_MS): while a companion-mode
  // pause idles, a timer eventually plays the track at its very end so the
  // companion yields the iOS audio session. abandonedAfterPause marks that
  // the phone's player is sitting on the ended item; abandonIndex /
  // abandonPositionMs are the one-tap resume target.
  private abandonTimer: number | null = null;
  private abandonedAfterPause = false;
  private abandonIndex = -1;
  private abandonPositionMs = 0;

  configure(jf: JellyfinClient | null): void {
    this.jf = jf;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.rev++;
    for (const fn of this.listeners) fn();
  }

  get revision(): number {
    return this.rev;
  }

  // force a ui refresh after mutating a queued track in place (e.g. favorite)
  touch(): void {
    this.emit();
  }

  get linkGeneration(): number {
    return this.linkGen;
  }

  // Called on every genuine gateway transition (drop or reconnect).
  onLink(fn: () => void): () => void {
    this.linkListeners.add(fn);
    return () => {
      this.linkListeners.delete(fn);
    };
  }

  current(): Track | null {
    return this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
  }

  positionNow(): number {
    if (this.intentPlaying && this.positionMs >= 0) {
      return Math.min(this.positionMs + (Date.now() - this.positionAt), this.durationMs || Infinity);
    }
    return this.positionMs;
  }

  get trackDurationMs(): number {
    return this.durationMs;
  }

  private streamUrl(track: Track, startMs = 0): string {
    return this.jf!.streamUrl(track.id, this.deviceId, startMs);
  }

  async ensureDeviceId(): Promise<void> {
    if (this.deviceId) return;
    const client = getClient();
    try {
      const r = await client.store.get({ key: DEVICE_ID_KEY });
      if (r.ok && r.response.value) {
        this.deviceId = r.response.value;
        return;
      }
    } catch {
      // fall through to generate
    }
    this.deviceId = crypto.randomUUID();
    try {
      await client.store.put({ key: DEVICE_ID_KEY, value: this.deviceId });
    } catch {
      // non-fatal
    }
  }

  private newSession(): string {
    this.sessionId = crypto.randomUUID();
    return this.sessionId;
  }

  private armProgressTimer(): void {
    this.clearProgressTimer();
    this.progressTimer = window.setInterval(() => {
      const t = this.current();
      if (t && this.intentPlaying && this.jf) {
        void this.jf.reportProgress(t.id, this.sessionId, this.positionNow(), false);
      }
    }, PROGRESS_REPORT_MS);
    // End-of-track backstop. The phone doesn't reliably report stopped /
    // paused when a track ends — it can go completely quiet — so in the
    // last seconds we stop waiting for its snapshot and ask it directly.
    // A fresh stateGet self-corrects our clock during stalls (the seek bar
    // stops lying) and lets the normal snapshot branches advance the queue
    // with fresh data; if the phone still claims "playing" at the cap, the
    // track is over and we advance. Link-down ends stay owned by the
    // reconnect heal, not this timer.
    this.endWatchTimer = window.setInterval(() => {
      const t = this.current();
      // awaitingStart only blocks while the phone is still spinning up; a
      // stale one (quiet phone that never confirmed "playing") must not
      // disable the backstop — the poll below asks the phone directly.
      const spinningUp =
        this.awaitingStart && Date.now() - this.lastPlayAt < PLAY_GRACE_MS;
      if (!t || !this.intentPlaying || spinningUp || this.external) return;
      if (this.gatewayUp === false) return;
      const durMs = t.durationMs;
      if (!(durMs > 0)) return;
      if (this.positionNow() < durMs - END_POLL_WINDOW_MS) return;
      void this.pollEndOfTrack(t.id, durMs);
    }, END_WATCH_MS);
  }

  // Re-arm the timers if they died: pause clears them and resume never
  // re-armed them (only playAt did), which silently killed both scrobble
  // reports and the end-of-track backstop after any pause/resume cycle.
  private ensureTimers(): void {
    if (this.progressTimer === null) this.armProgressTimer();
  }

  private endPolling = false;

  // Consecutive end-polls where the phone reports "playing" but its
  // position isn't advancing while our clock sits at the duration cap.
  // Covers a quiet/stale companion that never sends its end signal: after
  // a few stuck polls the track is treated as over and we advance.
  private stuckEndPolls = 0;
  private lastEndPollPosMs = 0;

  private async pollEndOfTrack(trackId: string, durMs: number): Promise<void> {
    if (this.endPolling) return;
    this.endPolling = true;
    try {
      const res = await getClient().player.stateGet();
      if (!res.ok) return;
      // The track changed while we were asking (user skipped, another
      // path advanced): this answer is stale, drop it.
      if (this.current()?.id !== trackId) return;
      const st = res.response.state;
      const pb = st.playback;
      // Feed the fresh state through the normal path so the clock, intent,
      // and the paused-end / stopped branches stay consistent.
      this.handleSnapshot({
        context: st.context ? { uri: st.context.uri } : null,
        playback: { state: pb.state, positionMs: pb.positionMs },
      });
      // The phone is parked at the cap still claiming "playing": the track
      // ended with no end signal. Advance — but only if the snapshot above
      // didn't already move us off this track.
      const cur = this.current();
      if (
        cur && cur.id === trackId &&
        this.intentPlaying && !this.awaitingStart && !this.external &&
        pb.state === 'playing' && pb.positionMs >= durMs - END_EPS_MS
      ) {
        void this.next(true);
      }
      // Stuck-phone backstop: our clock is at the cap but the phone keeps
      // reporting "playing" from behind without its position advancing
      // (stale cache / quiet companion that never sends its end signal).
      // A buffering stall looks the same briefly, so require several
      // consecutive stuck polls before treating the track as over.
      const atCap = this.positionNow() >= durMs - END_EPS_MS;
      if (pb.state === 'playing' && atCap && pb.positionMs < durMs - END_EPS_MS) {
        if (pb.positionMs <= this.lastEndPollPosMs + 1000) this.stuckEndPolls++;
        else this.stuckEndPolls = 0;
        this.lastEndPollPosMs = pb.positionMs;
        if (this.stuckEndPolls >= 3) {
          this.stuckEndPolls = 0;
          this.lastEndPollPosMs = 0;
          if (this.current()?.id === trackId) void this.next(true);
        }
      } else {
        this.stuckEndPolls = 0;
        this.lastEndPollPosMs = 0;
      }
    } catch {
      // link hiccup mid-poll: skip this tick, the next one retries
    } finally {
      this.endPolling = false;
    }
  }

  private clearProgressTimer(): void {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.endWatchTimer !== null) {
      window.clearInterval(this.endWatchTimer);
      this.endWatchTimer = null;
    }
  }

  // Pause-yield abandon (see ABANDON_AFTER_PAUSE_MS). The companion never
  // releases the iOS audio session on pause, and its ~10s keepalive keeps
  // re-asserting exclusive — so Finamp on the phone gets fought for focus.
  // After a pause idles long enough we play the track at its very end: the
  // zero-length tail finishes instantly, the companion sees a natural end
  // (or a load failure — both yield the session), tears down Now Playing
  // and its remote commands, and its keepalive drops to mixed. The user
  // never sees any of this: the UI stays "paused", and resume re-plays
  // from the saved position with one tap.
  private armAbandonTimer(delayMs = ABANDON_AFTER_PAUSE_MS): void {
    this.clearAbandonTimer();
    this.abandonIndex = this.index;
    this.abandonPositionMs = this.positionNow();
    this.abandonTimer = window.setTimeout(() => {
      this.abandonTimer = null;
      void this.abandonAfterPause();
    }, delayMs);
  }

  private clearAbandonTimer(): void {
    if (this.abandonTimer !== null) {
      window.clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
  }

  private disarmAbandon(): void {
    this.clearAbandonTimer();
    this.abandonedAfterPause = false;
  }

  private async abandonAfterPause(): Promise<void> {
    const t = this.queue[this.abandonIndex];
    const durMs = t?.durationMs ?? 0;
    if (!t || !this.jf || !(durMs > 0)) return;
    // Only while still paused in companion mode on the same track. Any
    // user transport action meanwhile (resume, skip, seek, new play)
    // disarmed the timer first, so reaching here means true idle.
    if (this.intentPlaying || this.remoteActive || this.external) return;
    if (this.abandonedAfterPause || this.index !== this.abandonIndex) return;
    // Mark first: a resume racing this send must take the playAt path,
    // and the stale end can never advance the queue (snapshot guards below).
    this.abandonedAfterPause = true;
    try {
      await getClient().player.play({
        uri: this.streamUrl(t, durMs),
        context: { contextUri: `${CONTEXT_PREFIX}${t.id}` },
      });
      // Server hygiene: the session is over — don't leave it "paused" forever.
      void this.jf.reportStopped(t.id, this.sessionId, this.abandonPositionMs).catch(() => {});
    } catch {
      // The link is down: the session stays claimed, no worse than today.
      // Clear the flag so resume() takes the normal path; the next user
      // pause re-arms the timer.
      this.abandonedAfterPause = false;
    }
  }

  async playQueue(tracks: Track[], startIndex = 0, shuffle = this.shuffle): Promise<void> {
    if (!tracks.length || !this.jf) return;
    if (this.remoteActive) {
      // Hand the whole queue to the client: it builds its own player-side
      // queue from the item ids. Mirror it locally so the Queue view shows
      // what the client plays; polls keep the current index in sync by track id.
      let list = [...tracks];
      let idx = Math.max(0, Math.min(startIndex, list.length - 1));
      if (shuffle && list.length > 1) {
        const first = list[idx];
        list = [first, ...shuffled(list.filter((_, i) => i !== idx))];
        idx = 0;
      }
      this.queue = list;
      this.index = idx;
      this.loading = true;
      this.error = null;
      this.errorDetail = null;
      this.emit();
      try {
        await this.remotePlayNow(list, idx);
        this.lastRemoteCmdAt = Date.now();
      } catch (e) {
        this.setRemoteCommandError(e);
      }
      this.emit();
      this.pollRemoteSoon();
      return;
    }
    let list = [...tracks];
    let idx = Math.max(0, Math.min(startIndex, list.length - 1));
    if (shuffle && list.length > 1) {
      const first = list[idx];
      list = [first, ...shuffled(list.filter((_, i) => i !== idx))];
      idx = 0;
    }
    this.queue = list;
    await this.playAt(idx);
  }

  private async playAt(i: number, startMs = 0): Promise<void> {
    const track = this.queue[i];
    if (!track || !this.jf) return;
    // Any real play supersedes a pending or completed pause-yield abandon.
    this.disarmAbandon();
    const gen = ++this.playGen;
    const prev = this.current();
    if (prev && prev.id !== track.id) {
      void this.jf.reportStopped(prev.id, this.sessionId, this.positionNow()).catch(() => {});
    }
    this.index = i;
    this.durationMs = track.durationMs;
    this.positionMs = Math.max(0, Math.min(startMs, track.durationMs || 0));
    this.positionAt = Date.now();
    this.loading = true;
    this.error = null;
    this.errorDetail = null;
    this.external = false;
    this.awaitingStart = true;
    this.lastPlayAt = Date.now();
    this.lastPauseAt = 0;
    this.newSession();
    this.emit();
    // One attempt to start the phone's player; a superseded play (gen
    // mismatch) never touches state afterwards.
    const attempt = async (isRetry: boolean): Promise<void> => {
      if (gen !== this.playGen) return;
      try {
        await getClient().player.play({
          uri: this.streamUrl(track, startMs),
          context: { contextUri: `${CONTEXT_PREFIX}${track.id}` },
        });
        if (gen !== this.playGen) return;
        // Optimistic intent: don't wait for the phone to echo "playing" —
        // a quiet companion may never send it, which would leave
        // intentPlaying false (and awaitingStart stuck true) and silently
        // disable the end-of-track backstop, stranding the queue.
        // awaitingStart still guards the transient post-play "stopped".
        this.intentPlaying = true;
        this.stuckEndPolls = 0;
        this.lastEndPollPosMs = 0;
        void this.jf!.reportPlaying(track.id, this.sessionId);
        this.armProgressTimer();
        void this.persist();
      } catch (err) {
        if (gen !== this.playGen) return;
        if (!isRetry) {
          // The companion can fumble a new play while it is still tearing
          // down the old item (rapid skip, or auto-advance landing exactly
          // at track end): give it a moment and try once more before
          // surfacing an error.
          await new Promise((r) => setTimeout(r, 1200));
          return attempt(true);
        }
        this.loading = false;
        this.awaitingStart = false;
        this.error = err instanceof Error ? err.message : 'could not start playback';
        this.errorDetail = null;
        this.emit();
      }
    };
    await attempt(false);
  }

  async toggle(): Promise<void> {
    if (this.external) return;
    if (this.remoteActive) {
      // Optimistic flip; the poll corrects us if the command didn't land.
      const pausing = this.intentPlaying;
      this.intentPlaying = !pausing;
      this.error = null;
      this.emit();
      this.armRemotePoll(); // flip to the matching poll cadence immediately
      this.remoteCommand(pausing ? 'Pause' : 'Unpause');
      return;
    }
    const t = this.current();
    if (!t) return;
    const client = getClient();
    try {
      if (this.intentPlaying) {
        this.intentPlaying = false;
        this.lastPauseAt = Date.now();
        void this.jf?.reportProgress(t.id, this.sessionId, this.positionNow(), true);
        this.clearProgressTimer();
        this.emit();
        await client.player.pause();
        // Arm the pause-yield: if this pause idles long enough, the track
        // is abandoned at its end so the phone yields its audio session.
        this.armAbandonTimer();
      } else {
        this.clearAbandonTimer();
        // After a pause-yield abandon the phone's player is sitting on an
        // ended item, so resume() would just fail — re-play from the saved
        // position instead. One tap, same as a normal resume.
        if (this.abandonedAfterPause) {
          const idx = this.abandonIndex >= 0 ? this.abandonIndex : this.index;
          const pos = this.abandonPositionMs;
          this.abandonedAfterPause = false;
          await this.playAt(idx, pos);
          return;
        }
        // After a phone-side failure ("Playback failed") the phone's
        // player is dead: resume() just fails again and loops the error.
        // Restart the track instead so one tap recovers.
        if (this.error) {
          await this.playAt(this.index);
          return;
        }
        this.awaitingStart = true;
        this.lastPlayAt = Date.now();
        this.lastPauseAt = 0;
        this.emit();
        await client.player.resume();
        // Optimistic intent: the phone doesn't reliably echo "playing"
        // after a resume (quiet companion), and the end-of-track backstop
        // runs on intentPlaying — without this a resume could strand the
        // queue at track end. Timers were cleared on pause; re-arm them
        // now instead of waiting for a snapshot that may never come.
        this.intentPlaying = true;
        this.ensureTimers();
        this.emit();
      }
      void this.persist();
    } catch {
      // snapshot will correct us
    }
  }

  async next(auto = false): Promise<void> {
    if (this.remoteActive) {
      // Optimistic advance of the mirror; the catch-up poll corrects us if
      // the command didn't land (pollRemote re-syncs the index by track id).
      if (this.queue.length > 1) {
        this.index = (this.index + 1) % this.queue.length;
        const t = this.current();
        if (t) {
          this.durationMs = t.durationMs;
          this.positionMs = 0;
          this.positionAt = Date.now();
          this.intentPlaying = true;
          this.error = null;
          this.emit();
        }
      }
      this.remoteCommand('NextTrack');
      return;
    }
    if (this.repeat === 'one' && auto) {
      await this.playAt(this.index);
      return;
    }
    let n = this.index + 1;
    if (n >= this.queue.length) {
      if (this.repeat === 'all' && this.queue.length) n = 0;
      else {
        this.intentPlaying = false;
        this.clearProgressTimer();
        this.disarmAbandon();
        this.stuckEndPolls = 0;
        this.lastEndPollPosMs = 0;
        const t = this.current();
        if (t) void this.jf?.reportStopped(t.id, this.sessionId, this.positionNow()).catch(() => {});
        this.emit();
        return;
      }
    }
    await this.playAt(n);
  }

  async prev(): Promise<void> {
    if (this.remoteActive) {
      // restart the track when it is well underway, like every other player
      if (this.positionNow() > 4000) {
        this.positionMs = 0;
        this.positionAt = Date.now();
        this.emit();
        this.remoteCommand('Seek', 0);
      } else {
        // Optimistic step back of the mirror; the catch-up poll corrects us
        // if the command didn't land.
        if (this.queue.length > 1 && this.index > 0) {
          this.index -= 1;
          const t = this.current();
          if (t) {
            this.durationMs = t.durationMs;
            this.positionMs = 0;
            this.positionAt = Date.now();
            this.intentPlaying = true;
            this.error = null;
            this.emit();
          }
        }
        this.remoteCommand('PreviousTrack');
      }
      return;
    }
    // restart the track when it is well underway, like every other player
    if (this.positionNow() > 4000) {
      await this.seekTo(0);
      return;
    }
    const p = this.index - 1;
    if (p >= 0) await this.playAt(p);
    else await this.seekTo(0);
  }

  async seekTo(ms: number): Promise<void> {
    const t = this.current();
    if (!t) return;
    const clamped = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.positionMs = clamped;
    this.positionAt = Date.now();
    // A seek while paused moves the pause-yield resume target too, so a
    // later resume lands where the user scrubbed to, not where they paused.
    if (this.abandonTimer !== null || this.abandonedAfterPause) {
      this.abandonPositionMs = clamped;
    }
    this.emit();
    if (this.remoteActive) {
      // No Bluetooth pacing needed: one server command seeks the client.
      this.remoteCommand('Seek', clamped);
      return;
    }
    // Pace the phone-bound send (see SEEK_PACE_MS). A seek scheduled for a
    // track that is no longer current when the timer fires is dropped.
    const trackId = t.id;
    this.pendingSeekMs = clamped;
    if (this.seekSendTimer !== null) return; // one already scheduled; it takes the latest
    const wait = Math.max(0, SEEK_PACE_MS - (Date.now() - this.lastSeekSentAt));
    this.seekSendTimer = window.setTimeout(() => {
      this.seekSendTimer = null;
      const target = this.pendingSeekMs;
      this.pendingSeekMs = null;
      if (target === null || this.current()?.id !== trackId) return;
      this.lastSeekSentAt = Date.now();
      this.lastSeekTargetMs = target;
      // The link can flap mid-send; swallow-and-forget used to lose the
      // seek silently ("can't seek"). One retry 2s later, still guarded
      // by the track check; beyond that the next snapshot corrects the UI.
      let retried = false;
      const send = (): void => {
        if (this.current()?.id !== trackId) return;
        getClient()
          .player.seekTo({ positionMs: Math.round(target) })
          .catch(() => {
            if (retried) return;
            retried = true;
            window.setTimeout(send, 2000);
          });
      };
      send();
    }, wait);
  }

  setShuffle(on: boolean): void {
    // Remote mode: the client owns shuffle/repeat for its own queue.
    if (this.remoteActive) return;
    this.shuffle = on;
    this.emit();
    void this.persistPrefs();
  }

  cycleRepeat(): void {
    // Remote mode: the client owns shuffle/repeat for its own queue.
    if (this.remoteActive) return;
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    this.emit();
    void this.persistPrefs();
  }

  setLyricsTab(on: boolean): void {
    this.lyricsTab = on;
    this.emit();
    void this.persistPrefs();
  }

  playNext(track: Track): void {
    if (this.remoteActive) {
      // The client owns its queue: only starting fresh playback makes sense.
      if (!this.current()) void this.playQueue([track], 0);
      return;
    }
    if (this.index < 0) {
      void this.playQueue([track], 0);
      return;
    }
    this.queue.splice(this.index + 1, 0, track);
    this.emit();
  }

  addToQueue(track: Track): void {
    if (this.remoteActive) {
      // The client owns its queue: only starting fresh playback makes sense.
      if (!this.current()) void this.playQueue([track], 0);
      return;
    }
    if (this.index < 0) {
      void this.playQueue([track], 0);
      return;
    }
    this.queue.push(track);
    this.emit();
  }

  removeAt(i: number): void {
    // Remote mode: the queue lives in the client; mutating our mirror would desync.
    if (this.remoteActive) return;
    if (i < 0 || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) {
      // removing the playing track stops playback; keep the rest queued
      this.intentPlaying = false;
      this.clearProgressTimer();
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      const t = this.current();
      if (t) {
        this.durationMs = t.durationMs;
        this.positionMs = 0;
        this.positionAt = Date.now();
      } else {
        this.index = -1;
      }
    }
    this.emit();
  }

  clearQueue(): void {
    // Remote mode: the queue lives in the client; mutating our mirror would desync.
    if (this.remoteActive) return;
    this.queue = [];
    this.index = -1;
    this.intentPlaying = false;
    this.clearProgressTimer();
    this.emit();
    void this.persist();
  }

  async jumpTo(i: number): Promise<void> {
    if (this.remoteActive) {
      // The client has no index-skip command: restart its queue at i.
      if (i < 0 || i >= this.queue.length || !this.jf || !this.remoteSessionId) return;
      this.index = i;
      this.positionMs = 0;
      this.positionAt = Date.now();
      this.loading = true;
      this.error = null;
      this.errorDetail = null;
      this.emit();
      try {
        await this.remotePlayNow(this.queue, i);
        this.lastRemoteCmdAt = Date.now();
      } catch (e) {
        this.setRemoteCommandError(e);
      }
      this.emit();
      this.pollRemoteSoon();
      return;
    }
    return this.playAt(i);
  }

  // ---- Remote mode ----

  get remoteActive(): boolean {
    return this.remoteSessionId !== null;
  }

  async discoverRemote(): Promise<RemoteSessionInfo[]> {
    if (!this.jf) return [];
    const sessions = await new RemoteControl(this.jf).discover();
    // If the last-used session isn't advertised anymore (client suspended or
    // closed), show it greyed out as offline so it reads as "away", not lost.
    const saved = await this.loadPersistedRemote();
    if (saved?.sessionId && !sessions.some(s => s.id === saved.sessionId)) {
      sessions.push({
        id: saved.sessionId,
        client: saved.client || 'Player',
        deviceName: saved.deviceName || 'Phone',
        nowPlayingName: null,
        isPlaying: false,
        lastActive: null,
        offline: true,
      });
    }
    return sessions;
  }

  private async loadPersistedRemote(): Promise<{ sessionId?: string; client?: string; deviceName?: string } | null> {
    try {
      const r = await getClient().store.get({ key: REMOTE_KEY });
      if (r.ok && r.response.value) return JSON.parse(r.response.value);
    } catch {
      // no saved session
    }
    return null;
  }

  // The remote session id went stale (server 404, or the poll can't find it).
  // Clients get a new session id when their connection drops and reopens —
  // look for the same app on the same device and re-attach to its new id.
  // 'healed' only when attached to a *different* session id; 'link-down'
  // when discovery itself couldn't reach the server (not a dead session).
  private async healRemoteSession(): Promise<'healed' | 'not-found' | 'link-down'> {
    if (!this.jf || !this.remoteActive) return 'not-found';
    const oldSid = this.remoteSessionId;
    const gen = this.remoteGen;
    let sessions: RemoteSessionInfo[];
    try {
      sessions = await new RemoteControl(this.jf).discover();
    } catch {
      return 'link-down';
    }
    if (gen !== this.remoteGen) return 'not-found';
    const match =
      sessions.find(s => s.id !== oldSid && s.client === this.remoteClient && s.deviceName === this.remoteDevice) ??
      sessions.find(s => s.id !== oldSid && s.client === this.remoteClient);
    if (!match) return 'not-found';
    this.remoteSessionId = match.id;
    this.remoteClient = match.client;
    this.remoteDevice = match.deviceName;
    try {
      await getClient().store.put({
        key: REMOTE_KEY,
        value: JSON.stringify({ sessionId: match.id, client: match.client, deviceName: match.deviceName }),
      });
    } catch {
      // non-fatal
    }
    return 'healed';
  }

  // Send the Play command, healing a stale session id once before giving up.
  // Only a server answer (HTTP status) means the id is stale; a transport
  // failure is the Bluetooth link, not the session — don't heal, report it.
  private async remotePlayNow(list: Track[], idx: number): Promise<void> {
    if (!this.jf || !this.remoteSessionId) throw new JellyfinError(0, 'no remote session');
    const rc = new RemoteControl(this.jf);
    try {
      await rc.playNow(this.remoteSessionId, list.map(t => t.id), idx);
      return;
    } catch (e) {
      if (!(e instanceof JellyfinError) || e.status === 0) throw e;
      const healed = await this.healRemoteSession();
      if (healed !== 'healed' || !this.jf || !this.remoteSessionId) {
        throw healed === 'link-down' ? new JellyfinError(0, 'link down') : e;
      }
      await new RemoteControl(this.jf).playNow(this.remoteSessionId, list.map(t => t.id), idx);
    }
  }

  // A server answer (4xx/5xx) and the Bluetooth link dying are different
  // failures: only the server's words diagnose, so only they are shown.
  private setRemoteCommandError(e: unknown): void {
    const serverSaid = e instanceof JellyfinError && e.status !== 0;
    this.loading = false;
    this.error = serverSaid ? 'Could not reach the player.' : 'The phone link dropped.';
    this.errorDetail = serverSaid && e instanceof Error ? e.message : null;
    this.emit();
  }

  // Engage remote mode: stop any local companion playback (two audio
  // sources on the phone would fight), then mirror the remote session.
  async enableRemote(sessionId: string, client: string, deviceName: string): Promise<void> {
    if (!this.jf) return;
    const gen = ++this.remoteGen;
    this.clearProgressTimer();
    if (this.healTimer !== null) {
      window.clearTimeout(this.healTimer);
      this.healTimer = null;
    }
    if (this.seekSendTimer !== null) {
      window.clearTimeout(this.seekSendTimer);
      this.seekSendTimer = null;
    }
    this.intentPlaying = false;
    this.loading = true;
    this.error = null;
    this.errorDetail = null;
    this.remoteLinkDown = false;
    this.remoteTransportFails = 0;
    this.external = false;
    this.awaitingStart = false;
    this.emit();
    try {
      await getClient().player.pause();
    } catch {
      // companion may have nothing playing; ignore
    }
    if (gen !== this.remoteGen) return;
    this.remoteSessionId = sessionId;
    this.remoteClient = client;
    this.remoteDevice = deviceName;
    await this.pollRemote();
    if (gen !== this.remoteGen) return;
    this.loading = false;
    this.armRemotePoll();
    this.emit();
    try {
      await getClient().store.put({
        key: REMOTE_KEY,
        value: JSON.stringify({ sessionId, client, deviceName }),
      });
    } catch {
      // non-fatal
    }
  }

  disableRemote(): void {
    this.remoteGen++;
    if (this.remotePollTimer !== null) {
      window.clearInterval(this.remotePollTimer);
      this.remotePollTimer = null;
    }
    this.remoteSessionId = null;
    this.remoteClient = '';
    this.remoteDevice = '';
    this.remoteLinkDown = false;
    this.remoteTransportFails = 0;
    this.queue = [];
    this.index = -1;
    this.intentPlaying = false;
    this.loading = false;
    this.positionMs = 0;
    this.durationMs = 0;
    this.emit();
    try {
      void getClient().store.put({ key: REMOTE_KEY, value: '' });
    } catch {
      // non-fatal
    }
  }

  private pollRemoteSoon(): void {
    window.setTimeout(() => {
      if (this.remoteActive) void this.pollRemote();
    }, 300);
  }

  private async pollRemote(): Promise<void> {
    const gen = this.remoteGen;
    let sid = this.remoteSessionId;
    if (!this.jf || !sid) return;
    let st: RemoteState | null | undefined;
    try {
      st = await new RemoteControl(this.jf).state(sid);
    } catch {
      st = undefined; // transport failure (link down), not a server answer
    }
    if (gen !== this.remoteGen) return;
    if (st === undefined) {
      // Don't mistake a dead link for a dead session: count consecutive
      // transport failures, and only then call the link dropped.
      this.remoteTransportFails++;
      if (this.remoteTransportFails >= 3 && !this.remoteLinkDown) {
        this.remoteLinkDown = true;
        this.error = 'The phone link dropped.';
        this.emit();
      }
      return;
    }
    this.remoteTransportFails = 0;
    if (this.remoteLinkDown) {
      // Link is back: clear the outage state; the poll below re-syncs.
      this.remoteLinkDown = false;
      if (this.error === 'The phone link dropped.') this.error = null;
    }
    if (!st) {
      // The session id is stale — the client probably reconnected under a new
      // id. Re-attach to it instead of dropping to local mode. But if the
      // link is down, keep the session: nothing proved it dead.
      const healed = await this.healRemoteSession();
      if (gen !== this.remoteGen) return;
      if (healed === 'healed' && this.remoteSessionId) {
        sid = this.remoteSessionId;
        try {
          st = await new RemoteControl(this.jf!).state(sid);
        } catch {
          return;
        }
        if (gen !== this.remoteGen) return;
      } else if (healed === 'link-down') {
        this.remoteLinkDown = true;
        this.error = 'The phone link dropped.';
        this.emit();
        return;
      }
      if (!st) {
        // Client closed or went offline: fall back to local mode.
        this.error = 'Lost the remote session.';
        this.disableRemote();
        return;
      }
    }
    this.remoteClient = st.client || this.remoteClient;
    this.remoteDevice = st.deviceName || this.remoteDevice;
    // The session is alive and has a track: any in-flight remote play has
    // landed (or been answered), so the spinner can go — the track-change
    // branch below handles the new-track case, this covers the same-track
    // case (e.g. right after a remote playQueue) that used to spin forever.
    if (st.track) this.loading = false;
    const cur = this.current();
    if (st.track && (!cur || cur.id !== st.track.id)) {
      // Track changed (the client advanced, or the user skipped on the phone).
      // Keep the mirrored queue when the new track is in it; otherwise the
      // session's queue changed out from under us — mirror the track alone.
      const qi = this.queue.findIndex(t => t.id === st.track!.id);
      if (qi >= 0) this.index = qi;
      else {
        this.queue = [st.track];
        this.index = 0;
      }
      this.durationMs = st.track.durationMs;
      this.positionMs = st.positionMs;
      this.positionAt = Date.now();
      this.loading = false;
      this.error = null;
      this.errorDetail = null;
    } else if (Date.now() - this.lastRemoteCmdAt > REMOTE_CMD_SETTLE_MS) {
      // Adopt the server's clock unless we just sent a command — our
      // optimistic local state wins until it lands.
      this.positionMs = st.positionMs;
      this.positionAt = Date.now();
      if (st.track) this.durationMs = st.track.durationMs;
    }
    this.intentPlaying = !st.paused && !!st.track;
    // The play state flipped under us (e.g. paused on the phone): switch
    // the poll to the matching cadence instead of waiting out the old one.
    if (this.lastArmedPlaying !== null && this.lastArmedPlaying !== this.intentPlaying) {
      this.armRemotePoll();
    }
    this.emit();
  }

  // Re-attach after an app restart: the persisted session first, else the
  // most recently active session that has something playing ("where the
  // song was playing last").
  async reconcileRemote(): Promise<void> {
    if (!this.jf || this.remoteActive) return;
    const saved = await this.loadPersistedRemote();
    const remote = new RemoteControl(this.jf);
    if (saved?.sessionId) {
      try {
        const st = await remote.state(saved.sessionId);
        if (st) {
          await this.enableRemote(saved.sessionId, saved.client || st.client, saved.deviceName || st.deviceName);
          return;
        }
      } catch {
        // persisted client not around; fall through to discovery
      }
    }
    try {
      const sessions = await remote.discover();
      const last = sessions.find(s => s.nowPlayingName);
      if (last) await this.enableRemote(last.id, last.client, last.deviceName);
    } catch {
      // nothing to adopt; stay in local mode
    }
  }

  private remoteCommand(cmd: 'Pause' | 'Unpause' | 'NextTrack' | 'PreviousTrack' | 'Seek', seekMs?: number): void {
    const sid = this.remoteSessionId;
    if (!sid || !this.jf) return;
    if (this.remoteLinkDown) {
      // Don't fire commands into a dead link; say so instead.
      this.error = 'The phone link dropped.';
      this.emit();
      return;
    }
    this.lastRemoteCmdAt = Date.now();
    new RemoteControl(this.jf)
      .command(sid, cmd, seekMs)
      .catch((e: unknown) => {
        const serverSaid = e instanceof JellyfinError && e.status !== 0;
        this.error = serverSaid ? 'Could not reach the player.' : 'The phone link dropped.';
        this.emit();
      });
    this.pollRemoteSoon();
  }

  // Feed gateway (phone Bluetooth) connection transitions here. Finch is
  // otherwise blind to link drops: snapshots keep arriving with the
  // daemon's extrapolated position while the phone restarts the track.
  // Ask the companion for its player state on (re)connect and feed it
  // through the normal snapshot path. A stuck companion sends nothing on
  // its own; without this the pause-yield abandon never arms for it.
  handleGateway(connected: boolean): void {
    const prev = this.gatewayUp;
    this.gatewayUp = connected;
    if (prev === null || prev === connected) return; // first sighting or no change
    // genuine transition: let views retry anything that failed mid-outage
    this.linkGen++;
    for (const fn of this.linkListeners) fn();
    if (this.remoteActive) {
      // Remote mode: every API call rides this link. On a drop, stop
      // trusting the session (commands short-circuit with 'The phone link
      // dropped.') instead of clinging to a dead session and 404ing; on
      // reconnect, re-sync — the poll heals a rotated session id or falls
      // back to local if the client is really gone.
      if (!connected) {
        this.remoteTransportFails = 0;
        if (!this.remoteLinkDown) {
          this.remoteLinkDown = true;
          this.error = 'The phone link dropped.';
          // Pause the remote poll while the link is down: hammering a dead
          // link keeps the Bluetooth connection from recovering.
          if (this.remotePollTimer !== null) {
            window.clearInterval(this.remotePollTimer);
            this.remotePollTimer = null;
          }
          this.emit();
        }
      } else if (this.remoteLinkDown) {
        this.remoteLinkDown = false;
        if (this.error === 'The phone link dropped.') this.error = null;
        // Resume the poll on reconnect (it was paused above, or the poll
        // backstop below may have left it running).
        if (this.remotePollTimer === null) {
          this.armRemotePoll();
        }
        this.emit();
        void this.pollRemote();
      }
      return;
    }
    if (this.healTimer !== null) {
      window.clearTimeout(this.healTimer);
      this.healTimer = null;
    }
    if (!connected) return; // drop: nothing to heal until it comes back
    this.lastReconnectAt = Date.now();
    const t = this.current();
    if (!this.intentPlaying || !t || this.external) return;
    if (this.positionNow() < RECONNECT_HEAL_MIN_MS) return; // just started; nothing to restore
    const trackId = t.id;
    // Capture where the music was NOW: a post-reconnect snapshot may adopt
    // the phone's restarted (~0) position before the timer fires, which
    // would make positionNow() lie at heal time.
    const target = this.positionNow();
    // If our clock is parked at the duration cap, the track ended while the
    // link was down (its "stopped" never reached us). Seeking the phone back
    // to the very end would strand it there with no next track; advance the
    // queue instead — this is the lost auto-advance.
    const trackEnded = t.durationMs > 0 && target >= t.durationMs;
    this.healTimer = window.setTimeout(() => {
      this.healTimer = null;
      if (!this.intentPlaying || this.external) return;
      const cur = this.current();
      if (!cur || cur.id !== trackId) return;
      if (this.lastSnapAt > this.lastReconnectAt && this.snapPositionMs >= RECONNECT_HEAL_MIN_MS) return;
      if (trackEnded) {
        void this.next(true);
        return;
      }
      void this.seekTo(target);
    }, RECONNECT_SETTLE_MS);
  }

  // Feed every daemon snapshot through here. Returns nothing; emits on change.
  handleSnapshot(state: {
    context: { uri: string } | null;
    playback: { state: 'stopped' | 'paused' | 'playing'; positionMs: number };
  }): void {
    // Remote mode: daemon snapshots describe the companion's player, which
    // is idle — the polls own this state.
    if (this.remoteActive) return;
    const ctxUri = state.context?.uri ?? null;
    // remember the raw snapshot for resume reconciliation (app restarted
    // while the phone kept playing one of our tracks)
    this.snapSeen = true;
    this.lastSnapAt = Date.now();
    this.snapTrackId =
      ctxUri && ctxUri.startsWith(CONTEXT_PREFIX) ? ctxUri.slice(CONTEXT_PREFIX.length) : null;
    this.snapPlaying = state.playback.state === 'playing';
    this.snapPositionMs = state.playback.positionMs;
    if (ctxUri && !ctxUri.startsWith(CONTEXT_PREFIX)) {
      // another app took the phone; stop claiming playback
      if (!this.external) {
        this.external = true;
        this.intentPlaying = false;
        this.loading = false;
        this.clearProgressTimer();
        this.emit();
      }
      return;
    }
    if (this.external) {
      this.external = false;
    }
    const pb = state.playback;
    // A fresh snapshot proves the phone spun up; a stale awaitingStart
    // (quiet phone that never sent "playing") must not neuter the
    // paused-end / stopped branches below forever.
    if (this.awaitingStart && Date.now() - this.lastPlayAt > PLAY_GRACE_MS) {
      this.awaitingStart = false;
    }
    // True while a user-initiated pause is still travelling to the phone;
    // snapshots from before it landed are stale.
    const pauseGrace = Date.now() - this.lastPauseAt < PAUSE_GRACE_MS;
    if (pb.state === 'playing') {
      // Our own pause-yield abandon: the companion briefly reports
      // "playing" for the zero-length end-of-track item. It isn't real
      // playback — never resurrect intentPlaying or arm the end-watch for
      // it, or the queue would auto-advance into the next track.
      if (this.abandonedAfterPause) return;
      // A stale "playing" snapshot must not resurrect intentPlaying right
      // after the user paused: it flips the UI back to playing, keeps the
      // lyrics/progress moving, and arms the "stopped" branch below to
      // misfire next() and restart audio.
      if (pauseGrace) return;
      const oursBefore = this.positionNow();
      this.intentPlaying = true;
      this.ensureTimers();
      this.loading = false;
      this.awaitingStart = false;
      this.error = null;
      this.errorDetail = null;
      // A paced seek may not have reached the phone yet (up to 800ms):
      // this snapshot's pre-seek position must not snap our clock back
      // and make the seek look like it didn't take.
      if (this.pendingSeekMs === null) {
        this.positionMs = pb.positionMs;
        this.positionAt = Date.now();
      }
      const t = this.current();
      if (t && t.durationMs) this.durationMs = t.durationMs;
      // Late restart after a reconnect: the phone is near the track start
      // while we are far ahead (a manual seek-to-0 would have reset our own
      // clock too). Push it back to where the music was.
      if (
        Date.now() - this.lastReconnectAt < RECONNECT_WATCH_MS &&
        pb.positionMs < RECONNECT_HEAL_MIN_MS &&
        oursBefore - pb.positionMs > RESTART_GAP_MS
      ) {
        const trackId = this.current()?.id;
        const target = oursBefore;
        // Same lost-auto-advance case as handleGateway: our clock parked at
        // the duration cap means the track ended mid-outage.
        const durMs = this.current()?.durationMs ?? 0;
        const ended = durMs > 0 && target >= durMs;
        window.setTimeout(() => {
          if (!this.intentPlaying || this.external) return;
          if (this.current()?.id !== trackId) return;
          if (ended) {
            void this.next(true);
            return;
          }
          void this.seekTo(target);
        }, RECONNECT_SETTLE_MS);
      }
      this.emit();
    } else if (pb.state === 'paused') {
      // same paced-seek guard as the playing branch above; the abandon
      // item's end position must not snap our paused clock to the cap
      // (resume uses the saved abandon position, not this).
      if (this.pendingSeekMs === null && !this.abandonedAfterPause) {
        this.positionMs = pb.positionMs;
        this.positionAt = Date.now();
      }
      const wasIntent = this.intentPlaying && !this.awaitingStart;
      if (!this.awaitingStart) this.intentPlaying = false;
      this.loading = false;
      // Natural track end sometimes surfaces as "paused at the duration"
      // instead of "stopped" (companion-dependent). Advance the queue
      // instead of stranding. A real user pause always clears intent first
      // (toggle), so wasIntent tells the two apart; the snapshot must also
      // be for our current track, so a stale one can't double-advance.
      const durMs = this.current()?.durationMs ?? 0;
      const ended =
        wasIntent &&
        !pauseGrace &&
        durMs > 0 &&
        pb.positionMs >= durMs - END_EPS_MS &&
        this.snapTrackId === this.current()?.id;
      this.emit();
      if (ended) void this.next(true);
      else if (
        !this.awaitingStart &&
        !pauseGrace &&
        !this.abandonedAfterPause &&
        this.abandonTimer === null &&
        this.current() &&
        (this.snapTrackId === null || this.snapTrackId === this.current()?.id)
      ) {
        // Phone-side pause (interruption, another app took the iPhone's
        // audio session, or a pause from lock screen / BT controls): the
        // companion holds the session exclusive until its stream ends, so
        // yield quickly instead of fighting the phone's audio. A user pause
        // via toggle() already armed the longer timer; the abandonTimer check
        // keeps this from shortening it, and the pauseGrace check covers the
        // window before toggle() arms.
        this.armAbandonTimer(ABANDON_AFTER_PHONE_PAUSE_MS);
      }
    } else {
      // stopped: either we stopped it (intent already false) or the track
      // ended on its own -> advance. ignore the transient stopped right
      // after play() while the phone spins up.
      this.loading = false;
      if (this.awaitingStart && Date.now() - this.lastPlayAt < PLAY_GRACE_MS) return;
      // Our own pause landing can surface as a transient "stopped" on the
      // way to "paused" — never advance the queue for it.
      if (pauseGrace) {
        this.intentPlaying = false;
        this.emit();
        return;
      }
      this.awaitingStart = false;
      // A stale "stopped" for a track we already left must not double-
      // advance into the next one. Only when the companion echoes context —
      // context-less companions report null and keep the old behavior.
      if (this.snapTrackId !== null && this.snapTrackId !== this.current()?.id) {
        this.intentPlaying = false;
        this.emit();
        return;
      }
      if (this.intentPlaying) {
        this.intentPlaying = false;
        this.emit();
        void this.next(true);
      } else {
        this.emit();
      }
    }
    // The phone is playing/paused one of our tracks but our queue is empty
    // (app restarted mid-playback): pull the track from the server so the UI
    // shows the true now-playing status.
    if (!this.current() && this.snapTrackId && this.jf && this.adopting !== this.snapTrackId) {
      void this.adoptTrackId(this.snapTrackId, this.snapPositionMs, this.snapPlaying);
    }
  }

  // Adopt a track the phone is already playing into an empty queue.
  private async adoptTrackId(id: string, positionMs: number, playing: boolean): Promise<void> {
    if (!this.jf || this.current() || this.adopting === id) return;
    this.adopting = id;
    try {
      const t = await this.jf.trackById(id);
      if (this.current()) return; // something started meanwhile
      this.queue = [t];
      this.index = 0;
      this.durationMs = t.durationMs;
      this.positionMs = Math.max(0, positionMs);
      this.positionAt = Date.now();
      this.intentPlaying = playing;
      this.loading = false;
      this.awaitingStart = false;
      this.external = false;
      this.error = null;
      this.errorDetail = null;
      this.emit();
      void this.persist();
      // Adopted a paused track: the companion is holding the iOS audio
      // session exclusive with no intent from us (e.g. app restarted while
      // paused). Yield quickly so the phone's other audio isn't blocked.
      if (!playing && this.abandonTimer === null && !this.abandonedAfterPause) {
        this.armAbandonTimer(ABANDON_AFTER_PHONE_PAUSE_MS);
      }
    } catch {
      // leave the queue empty; a later snapshot or reconcile will retry
    } finally {
      if (this.adopting === id) this.adopting = null;
    }
  }

  // Called once when credentials become ready. If our queue is empty but
  // playback is actually underway — the phone kept playing after an app
  // restart, or the server shows a recent session for our device — adopt it
  // so the UI shows the true status instead of an empty player.
  async reconcileOnResume(): Promise<void> {
    if (!this.jf || this.current()) return;
    // daemon snapshot is ground truth: it already triggers adoption via
    // handleSnapshot, and a definitive stopped state means "not playing".
    if (this.snapTrackId) {
      await this.adoptTrackId(this.snapTrackId, this.snapPositionMs, this.snapPlaying);
      return;
    }
    if (this.snapSeen) return;
    try {
      const np = await this.jf.serverNowPlaying();
      if (np && !this.current()) {
        this.queue = [np.track];
        this.index = 0;
        this.durationMs = np.track.durationMs;
        this.positionMs = Math.max(0, np.positionMs);
        this.positionAt = Date.now();
        this.intentPlaying = !np.paused;
        this.loading = false;
        this.external = false;
        this.error = null;
        this.errorDetail = null;
        this.emit();
        void this.persist();
      }
    } catch {
      // no session info; stay empty
    }
  }

  handlePlayerError(type: string, reason?: string): void {
    // A seek the phone rejects (transcoded streams are live ffmpeg pipes:
    // AVPlayer cannot range-seek them, so the companion fails the seekTo).
    // Don't flash "Playback failed" and snap the clock back — restart the
    // track at the seek target via StartTimeTicks instead. lastSeekSentAt is
    // cleared so the fallback's own failure can't loop back in here; a new
    // user seek re-arms it.
    const t = this.current();
    if (
      type === 'playFailed' && t && !this.external &&
      Date.now() - this.lastSeekSentAt < 4000
    ) {
      const target = this.lastSeekTargetMs ?? this.positionMs;
      this.lastSeekSentAt = 0;
      this.lastSeekTargetMs = null;
      this.error = null;
      this.errorDetail = null;
      const trackId = t.id;
      void this.playAt(this.index, target).then(() => {
        // If the server ignored StartTimeTicks (it was a direct-play after
        // all), the phone sits near 0 while our clock shows the target:
        // finish with a native seek, which always works on direct streams.
        window.setTimeout(() => {
          if (this.current()?.id !== trackId) return;
          void getClient()
            .player.stateGet()
            .then((res) => {
              if (!res.ok || this.current()?.id !== trackId) return;
              if (res.response.state.playback.positionMs < target - 5000) {
                void this.seekTo(target);
              }
            })
            .catch(() => {});
        }, 1500);
      });
      return;
    }
    this.loading = false;
    this.awaitingStart = false;
    this.intentPlaying = false;
    this.clearProgressTimer();
    this.errorDetail = reason && reason.trim() ? reason.trim() : null;
    if (type === 'noGateway') this.error = 'Connect your phone to hear audio.';
    else if (type === 'schemeUnclaimed') this.error = 'Update the companion app to play audio.';
    else if (type === 'playFailed') this.error = 'Playback failed. Try another track.';
    else this.error = 'Could not play this track.';
    this.emit();
  }

  private async persistPrefs(): Promise<void> {
    try {
      await getClient().store.put({
        key: 'finch:prefs',
        value: JSON.stringify({ shuffle: this.shuffle, repeat: this.repeat, lyricsTab: this.lyricsTab }),
      });
    } catch {
      // non-fatal
    }
  }

  async loadPrefs(): Promise<void> {
    try {
      const r = await getClient().store.get({ key: 'finch:prefs' });
      if (r.ok && r.response.value) {
        const p = JSON.parse(r.response.value) as { shuffle?: boolean; repeat?: RepeatMode; lyricsTab?: boolean };
        if (typeof p.shuffle === 'boolean') this.shuffle = p.shuffle;
        if (p.repeat === 'off' || p.repeat === 'all' || p.repeat === 'one') this.repeat = p.repeat;
        if (typeof p.lyricsTab === 'boolean') this.lyricsTab = p.lyricsTab;
      }
    } catch {
      // non-fatal
    }
  }

  private async persist(): Promise<void> {
    // Remote mode has its own persistence (finch:remote-session); the
    // mirrored queue is the client's, not ours to resume locally.
    if (this.remoteActive) return;
    const t = this.current();
    if (!t) return;
    try {
      const data: PersistedQueue = {
        tracks: this.queue.slice(0, 200),
        index: this.index,
        positionMs: Math.round(this.positionNow()),
      };
      await getClient().store.put({ key: RESUME_KEY, value: JSON.stringify(data) });
    } catch {
      // non-fatal
    }
  }

  async loadPersisted(): Promise<PersistedQueue | null> {
    try {
      const r = await getClient().store.get({ key: RESUME_KEY });
      if (r.ok && r.response.value) {
        const p = JSON.parse(r.response.value) as PersistedQueue;
        if (Array.isArray(p.tracks) && p.tracks.length && p.index >= 0 && p.index < p.tracks.length) return p;
      }
    } catch {
      // non-fatal
    }
    return null;
  }

  // Cold-start queue restore, called after reconcileRemote() and
  // reconcileOnResume() have had their say. If neither re-attached a live
  // session nor adopted something already playing, bring back the last
  // local queue — paused at its saved position — so closing the app
  // doesn't lose the playlist/album you were in. Anything live (remote
  // session, companion snapshot, server session) always wins over this.
  async restorePersistedQueue(): Promise<void> {
    if (this.remoteActive || this.current() || !this.jf) return;
    const saved = await this.loadPersisted();
    if (!saved || this.remoteActive || this.current()) return;
    const track = saved.tracks[saved.index];
    this.queue = saved.tracks;
    this.index = saved.index;
    this.durationMs = track.durationMs;
    this.positionMs = track.durationMs > 0 ? Math.min(Math.max(0, saved.positionMs), track.durationMs) : Math.max(0, saved.positionMs);
    this.positionAt = Date.now();
    this.intentPlaying = false;
    this.loading = false;
    this.external = false;
    this.error = null;
    this.errorDetail = null;
    this.emit();
  }
}

export const player = new PlaybackEngine();

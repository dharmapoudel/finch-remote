## 1.0.53
- Closing Now Playing from a playlist/album detail screen no longer strands you: minimizing now restores the full navigation stack from before Now Playing opened, so the back button pops to the parent list instead of being a dead no-op on a single-item stack.
- Audio fight: Finch now proactively asks the companion for its player state every time the Bluetooth link (re)connects and feeds the answer through the normal snapshot path. A stuck iOS companion (holding the audio session exclusive after a pause, with its stream flag never cleared) sends no snapshot on its own, so the 15s pause-yield abandon previously never armed for it — now the proactive query triggers the yield.

## 1.0.52
- Scrolling long lists (e.g. All Playlists) no longer floods the Bluetooth link: artwork fetches for tiles that scroll out of view are now abandoned while still queued, before they ever touch the network. Previously every tile within the preload margin enqueued an un-cancellable fetch, so a fast scroll piled hundreds of fetches into the net gate, starved the remote poll and list data, and could stall the link until the phone dropped it. The gate now takes an optional skip-check evaluated at dequeue time; tile artwork passes one tied to its viewport visibility (the tile observer stays connected instead of disconnecting after the first hit).

## 1.0.51
- Pause-yield abandon now also triggers on phone-side pauses: previously it only armed when you paused from Finch itself, so a pause from an interruption (phone call, another app taking the iPhone's audio, lock-screen pause) left the companion holding the iOS audio session exclusive forever — blocking all other iPhone audio on every Bluetooth connect. Phone-side pauses now yield after 15s (Finch-initiated pauses keep the 60s grace so short interruptions still auto-resume); a paused track adopted after an app restart yields the same way.

## 1.0.50
- Playlist detail screen gains a like button: a heart next to Play/Shuffle (playlists only) that toggles the playlist's favorite state with an optimistic update and revert on failure; the favorites rails refresh on next visit. The long-press playlist menu also gains Add/Remove favorites (the "Favorite playlists" empty state already promised this).

## 1.0.49
- Rail tiles no longer stretch when a section holds fewer than 5 items: each tile keeps the exact 5-column width ((100% - gaps) / 5) instead of growing to fill the row, so short sections (e.g. 2-3 favorites) show normal-sized tiles left-aligned. Full 5-item sections still fill the row edge to edge with no blank space.

## 1.0.48
- Rail rows now fill the full width: the 5 tiles in every section rail flex to equal shares of the row, so the space is evenly distributed with no blank gap on the right. (Tile artwork stays square and the layout is unchanged otherwise.)

## 1.0.47
- Queue auto-advance made reliable: play and resume now set the playing intent optimistically instead of waiting for the phone to echo "playing" — a quiet companion (its end confirmation lost over Bluetooth) used to leave the end-of-track backstop silently disabled and strand the queue. A stale spin-up guard no longer blocks the backstop or the paused/stopped end branches, a stuck-phone backstop advances after several polls with a non-advancing position at the duration cap, and a stale "stopped" for an already-left track can't double-advance.

## 1.0.10
- Bluetooth diet: ALL phone-tunnel traffic (JSON, artwork, remote commands) now flows through one shared 3-slot gate, so the phone is never asked to juggle ~9 concurrent fully-buffered fetches at once — the thing that was wedging the companion and stalling the link on app load. User taps (pause/next/seek/play) jump the queue.
- Artwork goes on a diet: tiles 300px/q90 -> 256px/q80, hero 600px -> 512px (~40% fewer bytes per image), and art is now cached persistently in the daemon store (48 most recent) — a cold start reuses art it already saw without downloading a byte.
- Remote poll is adaptive: 15s while playing, 60s when idle (was a flat 10s — the fastest network poll of any Bridgething app). Link-drop detection still works (3 consecutive failures), just on the slower cadence when nothing is playing.
- Lyrics toggle uses the new text-lines icon; the Library tab uses the new 2x2 grid icon.

## 1.0.2
- Remote-mode play fixes: (1) tapping a song in remote mode used to leave the play/pause button spinning forever — the poll only cleared the loading spinner when the track *changed*, so a successful play of the requested track never cleared it. The spinner now clears whenever the session reports a live track. (2) when asking the remote player to start songs fails, Finch now shows the server's own error (status/reason) under the friendly message instead of just "Could not reach the player.", so a failure diagnoses itself.

- Remote-mode fixes: (1) next/previous no longer leave the UI stale for ~1s — the mirrored queue now advances optimistically like play/pause already did, and the catch-up poll after a command runs at 300ms instead of 900ms (the poll still corrects the mirror if a command didn't land). Note: a small end-to-end delay remains by physics — the command travels Car Thing → Bluetooth → phone → Jellyfin server → the player's websocket, and the player itself takes a moment to switch tracks. (2) the "Play on" picker now shows your last-used session greyed out as offline when it isn't advertising anymore (iOS suspends backgrounded apps, which drops their session from the server) instead of silently disappearing from the list. Sessions only appear live when the app is open and signed into the same Jellyfin user as Finch.

- finch-remote starts here: the repo is renamed from bridgething-jellyfin-source to finch-remote and versioning restarts at 1.0.0. This release is the "Play on" remote mode (previously built as 0.1.54): Finch remote-controls another Jellyfin client on your phone — Finamp, Jellyfin Web, Swiftfin, whatever was playing last — instead of playing through the companion app.
- "Play on" remote mode: Finch can now remote-control another Jellyfin client on your phone — Finamp, Jellyfin Web, Swiftfin, whatever was playing last — instead of playing through the companion app. Pick it from the device pill in Now Playing (or the "Play on phone" button when nothing is playing): transport, seek and queue all drive the other player's own session through the Jellyfin server, while audio, lock-screen info and offline downloads stay in that app. The remote track is mirrored into Now Playing and the queue view; a server poll every 3s keeps the clock honest. Sessions are listed most recently active first, and on startup Finch picks up the session that was playing last. If the session disappears, Finch falls back to the companion path. The selection persists across app restarts.
- Remote-mode notes: shuffle/repeat and queue editing belong to the remote client while remote — Finch only mirrors. Knob volume still adjusts the phone's system volume.

## 0.1.40
- "Can't seek" fixes: (1) after "Playback failed", tapping play now restarts the track instead of calling resume() on the phone's dead player — resume just failed again and looped the error. One tap recovers. (2) a phone snapshot arriving during the 800ms paced-seek window no longer snaps our clock back to the pre-seek position (the phone hasn't received the seek yet); the bar now stays where the finger put it. (3) if the phone-bound seek send itself throws (link flapped mid-send), it retries once 2s later instead of silently dropping the seek.

## 0.1.39
- Link-drop resilience for browsing: tapping a playlist (or anything else) while the phone link drops no longer parks the app on a raw "Transport Channel Closed" error. The message now reads "The phone link dropped while loading.", with a Try again button — and when the link comes back, failed loads retry automatically.
- Album art recovers after a drop: artwork that failed mid-outage used to sit on the note-icon placeholder forever (including the Now Playing hero). It now refetches when the phone link returns; cache hits return instantly so only missing art re-hits the network.
- Detail views (album/artist/playlist/genre) now seed from the sticky cache like the Library does: reopening something you have seen before paints instantly, and background refresh failures stay silent.

## 0.1.38
- Seek bar fixed: dragging the seek bar fired a seekTo per pointer-move and tripped the daemon's Bluetooth rate limiter ("Rate limit exceeded" error overlay). The bar now follows the finger locally and sends exactly one seek on release; player.seekTo additionally paces phone-bound sends (800ms trailing window) so rapid taps can never trip the limiter either.
- Auto-advance fixed after Bluetooth drops: if the track ended mid-outage (our clock parked at the duration cap), the reconnect heal used to seek the phone back to the very end of the finished track and strand it there. It now advances to the next track instead — the lost auto-advance.
- Lyrics tab is now a sticky preference: it stays on across track changes, showing the album art for tracks with no lyrics and switching back to lyrics automatically when a track with lyrics comes up.

## 0.1.37
- Now Playing action row: lyrics and heart swapped positions (lyrics left, heart right), and both icons are now translucent when inactive — the active state stays a solid green icon.

## 0.1.36
- Outfit is now the default font across the entire app (it was only the Now Playing title/artist before). The Now Playing clock and seek times stay monospace, per the o-music reference — mono digits do not jitter as the time changes.

## 0.1.35

- Bluetooth drop recovery: when the phone's link drops and reconnects, the
  phone often restarts the current track from the beginning while the seek
  bar kept ticking. Finch now watches the gateway connection state
  (client.peer.onSnapshot) and, on reconnect, pushes the phone back to
  where the music was — with a snapshot guard that catches late restarts
  too. The drops themselves are a radio/firmware matter; this heals the
  aftermath. No heal fires when paused, when another app owns playback,
  when the track just started, or when a post-reconnect snapshot already
  shows the phone where it should be.
- Lyrics toggle no longer vanishes when the server version check fails over
  a flaky link (fail open; the per-track fetch still dims it when a track
  genuinely has no lyrics).

## 0.1.34

- Now Playing album art loads much faster: on-demand art now jumps to the
  front of the fetch queue ahead of tile prefetches, the hero drops from
  800px to 600px (the panel shows ~440px), and the already-fetched 200px art
  renders instantly as a soft progressive placeholder until the hero
  arrives. The accent tint is also extracted from the fast 200px art so the
  panel wash shows up with the first paint.

## 0.1.33

- Now Playing info panel rebuilt to match the o-music player exactly
  (left artwork section untouched): 15px mono clock with blinking colon
  top-left, Outfit 28px semibold title (30px in portrait) wrapping up to
  3 lines, 20px soft artist, seek bar + 12px mono times below it, Ghost
  transport buttons (gap-12, h-9 skips, h-10 play/pause with pop/tap
  press physics) with the play/pause glyph tinted by the cover's accent
  color, and heart + lyrics icons in the row o-music gives to its volume
  bar (green when active, no circles).
- Info panel background is now the blurred album art washed with a color
  extracted from the cover (o-music's hue-bucket accent algorithm, run
  locally on the cached art) instead of the flat dark fill.
- Seek rail picks up o-music's details: sheen strip travelling the fill
  while playing, halo pulse on the dot, white/18 track.

## 0.1.32

- Now Playing transport uses the o-music player's control buttons
  (ousachea/Ousa-Music-Player-v1): plain icon buttons with no circles —
  the green circle around play/pause is gone.
- Seek bar restyled to match: slim 3px rail, smaller 12px dot, compact
  times. It sits lower, at the top of where the green circle was, and the
  transport row moved down by the circle's radius.
- Heart/lyrics row: no more green circle backgrounds — the icon itself
  turns green when active.
- Fixed pause resuming on its own: a user-initiated pause is now
  authoritative for 2s, so stale "playing" snapshots arriving over the
  slow Bluetooth link can no longer flip the UI back to playing (which
  kept the lyrics moving) or let a transient "stopped" misfire the
  next-track advance and restart audio.

## 0.1.31

- Now Playing info panel matches the Spotify Car Thing reference alignment:
  the clock sits top-left flush with the content column (it was centered),
  and the seek bar + transport are parked in the lower half with the
  heart/lyrics row near the bottom.
- Queue sheet: drag down anywhere on the panel to close it (the sheet
  follows your finger, backdrop fades); the track list still scrolls
  normally — the drag only takes over when the list is at the top.
- Tapping the now-playing card at the top of the queue sheet opens the Now
  Playing screen.

## 0.1.30

- Bluetooth fix, round 2: artwork is now lazy-loaded — a tile only fetches
  its image when it scrolls near the viewport (400px preload margin). The
  library grid mounts hundreds of tiles at once and every one of them was
  firing a Bluetooth-tunnelled image fetch on mount, which kept knocking
  the phone link over. Combined with the 0.1.28 concurrency gate (max 4 in
  flight), the library now sips images instead of flooding them.

## 0.1.29

- Tapping a song (or Play/Shuffle/Instant Mix anywhere) now opens the Now
  Playing screen, instead of just starting audio behind the current view.
  "Play next" / "Add to queue" still just modify the queue without
  navigating.

## 0.1.28

- Queue bar is more visible (wider, slightly brighter) — the 0.1.27 bar was
  nearly invisible at 15% white. Same behavior: shows on every screen while
  a song is playing, tap/swipe up opens the queue sheet.
- Cold-start caching: Home rails and Library lists are now kept in a
  persistent (localStorage) sticky cache. A cold start paints the last known
  library instantly, then revalidates in the background; tab switches were
  already instant via the in-memory cache.
- Artwork pipeline hardened: all daemon image fetches go through a
  concurrency gate (max 4 in flight, FIFO). Prefetch is capped at 48 items,
  scoped to the current Library tab, and cancelled on tab switch — the old
  code fired one fetch per tile (hundreds at once) when the library loaded,
  which was knocking the Bluetooth link over.
- Landscape nav bar is icons-only now (Home/Library/Queue labels hidden);
  portrait keeps the labels.

## 0.1.27

- The mini now-playing bar is gone. Instead, the small transparent queue
  bar now shows at the bottom of EVERY screen while a song is playing
  (tap or swipe up opens the queue sheet). The queue bar/sheet moved from
  the Now Playing view to the app root so it's always available.

## 0.1.26

- Now Playing reverts to the pre-0.1.25 layout (album art left, info panel
  right) with the right-side controls in the Spotify Car Thing arrangement:
  clock, title/artist, progress bar with elapsed/-remaining times, transport,
  then heart + lyrics icons where the reference puts its volume bar (no
  volume slider). The queue sheet stays: its bottom handle bar is 2/3
  shorter and more transparent, and the sheet now closes by swiping down on
  the grabber (or tapping the backdrop) — the X close button is gone. The
  Glass Overlay ambient-inhibit signal from 0.1.25 is unchanged.

## 0.1.25

- Now Playing redesign: blurred album-art backdrop; the volume bar is gone, replaced by a slim action rail with love (favorite) + lyrics buttons; album art sits left and the lyrics toggle swaps the art panel for tick-by-tick synced lyrics; a slim bottom-center bar (tap or swipe up) opens the queue sheet; the device Clock is removed from the info column and an "UP NEXT" card (tap to open the queue) sits top-right.
- The Now Playing screen now holds the Glass Overlay ambient screensaver off while it's up (requires Glassy Overlay 0.3.27+): it signals the overlay through a `bridgething:ambient-inhibit` DOM event plus a sticky `window.__bridgethingAmbientInhibit` flag, cleared on unmount. This replaces the old synthetic-pointermove keepalive that only covered the lyrics tab.

## 0.1.24

- Removed the "Resume listening" banner from the Home screen.

## 0.1.23

- New app icon: simplified singing-finch head (crest reduced to two subtle feathers) in gold line-art with a fully transparent background — no more navy square, so the hub tile no longer trims it into a squircle. 512x512 RGBA PNG at 34.7KB, under the daemon 64KB cap.

## 0.1.22

- New app icon: the approved singing-finch head — short upward finch beak, bold swept-back crest, music note — in gold line-art on the dark navy background, full-bleed square, 256-color PNG at 17.8KB (well under the daemon 64KB cap).

## 0.1.21

- Buttons are now green instead of gold: play/pause, the active library pill, all CTA buttons and the connect button use the green accent (pressed state darkens). The progress bar and knob stay gold so the theme keeps both colors.

## 0.1.20

- Theme is now golden + green instead of yellow: rich gold (#d2a02e) for controls, progress, selections and the active lyric line; green (#34d399) for "alive" states — the bottom-nav active tab, now-playing highlights in the queue and track rows, the Home now-playing strip, and the mini-player progress ring.

## 0.1.19

- The Library screen no longer has the "Library" top bar with the back arrow — the Albums / Artists / Playlists / Genres row now sits at the top (the bottom tabs already handle navigation).

## 0.1.18

- App icon is now a close-up of the singing finch's head — the full-body bird was too small to read at tile size. (Re-encoded under the daemon's 64KB icon cap.)

## 0.1.17

- The seekbar now matches the reference: slimmer track and knob, elapsed on the left and remaining (-m:ss) on the right.
- The lyrics button is a simple notes icon; it dims and disables when the current track has no lyrics (lyrics are fetched when the track changes, cached per track).
- Removed the duplicate time labels under the seekbar (the progress bar's own row was doubled by the info panel's).
- Lyrics scrolling is now smooth instead of jumping line to line, so the highlight feels in sync with the audio.
- The lyrics view now shows the album art blurred and darkened behind the lyrics.
- The mini player shows a circular progress ring around the play/pause icon.

## 0.1.16

- Removed the volume slider from the Now Playing screen (the knob handles volume).
- Swiping down from the top edge of the Now Playing screen now minimizes it back to the mini player, returning to whichever tab was open before (Escape does the same).
- The lyrics toggle is now a microphone icon, and both the favorite and lyrics buttons moved to a bottom row under the transport controls.
- Fixed tofu blocks in lyrics: Noto Sans Devanagari is now bundled with the app so Devanagari-script lyrics, titles, and artists render on the device.
- While the lyrics view is open, Finch emits a quiet synthetic pointermove every 8 seconds so the Glass Overlay's idle timer never fires its ambient screen over the lyrics.

## 0.1.15

- Redesigned the Now Playing screen after the Spotify Car Thing reference: album art on the left (~55%), dark info panel on the right with the device clock, track title/artist, progress bar with elapsed/remaining times, centered prev/play/next transport, and a volume slider at the bottom (absolute levels via the daemon's setVolume; knob nudges still work and the slider follows). Favorite and lyrics toggles moved to the top-right corner; lyrics still swap the art panel. Portrait stacks art over the info panel.

## 0.1.13

- Removed the Playing tab from the bottom navigation (3 tabs now: Home, Library, Queue); Now Playing opens by tapping the mini player, same as before.
- Redesigned the Now Playing screen after the mock: split layout with artist/title/album, progress bar with times, and transport buttons on a deep maroon panel; album art fills the other side edge-to-edge. Portrait stacks art on top, info below. Kept the favorite and lyrics toggles; dropped the volume/shuffle/repeat/queue buttons from this screen (knob handles volume, Queue tab handles the queue).
- Removed the "Finch" top bar from the Home screen, freeing ~80px of vertical space.

## 0.1.41
- Playback failures now show the phone's own reason under the message. The seek rejection comes from the iPhone companion side, and Finch was dropping the reason it sends — surfacing it so the next failure says exactly what the phone choked on.

## 0.1.42
- Auto-advance the queue when the phone doesn't report "stopped" at track end: a natural end that surfaces as "paused at the duration" now advances (a real user pause still never does — intent distinguishes them), plus a 5s watchdog backstop for companions that sit at the duration cap still claiming "playing" (gated on the phone's last reported position so buffering stalls can't trigger it; link-down ends stay owned by the reconnect heal).
- Continue listening: the currently-playing track's tile is highlighted (leaf ring + title), and tapping it opens Now Playing without restarting it from scratch. Every other tile still plays from the start.

## 0.1.43
- Auto-advance, reworked: two holes found after 0.1.42. (1) The timers died after any pause/resume — pause clears them and only playAt re-armed them, so the end backstop was silently dead in exactly the pause/play testing pattern. The playing snapshot branch now re-arms them via ensureTimers(). (2) The phone can go completely quiet at track end (no stopped, no paused), so there was nothing to react to. In the last 10s of a track Finch now asks the phone directly (stateGet) instead of waiting: the fresh state feeds the normal snapshot branches (paused-end / stopped advance with fresh data, and the clock self-corrects during stalls), and a phone still claiming "playing" at the cap advances directly. Stale poll answers are dropped if the track changed mid-poll; link-down ends stay owned by the reconnect heal.

## 0.1.44
- The lyrics tab is now a persisted preference: it survives app restarts, not just track changes. Moved from NowPlaying's local state into the player (player.lyricsTab + setLyricsTab), stored in finch:prefs alongside shuffle/repeat and restored by loadPrefs() at boot.

## 0.1.45
- Now Playing layout: the lyrics and heart icons move into the transport row (lyrics left of previous, heart right of next) instead of their own row, and the single controls row is centered vertically between the seek bar and the bottom of the screen.

## 0.1.46
- Now Playing layout revision: the seek bar moves down to sit just above the controls, and the single transport row (lyrics left of previous, heart right of next) sits at the bottom edge where the old lyrics+heart row was.

## 0.1.47
- Now Playing: the song title + artist section stays put right under the clock — no longer pushed down toward the seek bar. The space between the titles and the bottom-anchored seek/controls cluster is just empty.

## 0.1.48
- Now Playing back to the 0.1.44 layout, with one change: the lyrics icon sits left of previous and the heart icon right of next in the transport row. Nothing else moved — seek bar, titles, and row positions are exactly as they were.

## 0.1.49
- Now Playing: the lyrics and heart buttons are pinned to the transport row's extremes, their icons lined up exactly with the seek bar's start and end. Previous/play/next stay centered between them, untouched.

## 0.1.50
- Now Playing: on servers without lyrics support (the toggle hides entirely), a same-size spacer keeps prev/play/next centered instead of the row collapsing left.

## 0.1.51
- Now Playing transport row: explicit w-full (belt and suspenders over flex stretch), plus a temporary tiny diagnostic readout (version + measured row width, bottom-right) to confirm on-device which build is running and whether the row spans the panel. Removed once confirmed.

## 0.1.52
- Now Playing: the lyrics/heart icons now truly sit at the seek bar's ends. The ml-3/mr-3 added in 0.1.49 had the margin sign backwards and inset both icons 24px; the Ghost's own -m-3 negative margin already pulls the 24px icon exactly to the row's edge (icon at x=0 / x=320). Removed the 0.1.51 diagnostic readout; fixed the lyrics-less-server spacer to w-6 (the Ghost's real 24px margin box).

## 0.1.53
- Playback reliability (Finamp research): (1) the stream URL now claims only codecs the iPhone can direct-play (mp3,aac,alac) — claiming opus/flac made the server direct-play them and the phone failed every such track; (2) seeks the phone rejects (transcoded streams are live pipes AVPlayer can't range-seek) now restart the track at the seek target via StartTimeTicks instead of flashing "Playback failed" and snapping the clock back, with a verify-and-native-seek correction in case the server ignored the offset; (3) playAt is now generation-guarded so rapid next/prev (or auto-advance racing a manual skip) can't have a stale play clobber the new one, and a failed track start retries once after 1.2s before surfacing an error (covers the companion fumbling a new play while tearing down the old item).

## 1.0.54
- Tapping the already-playing song in a track list no longer restarts it — it just opens Now Playing. The play/pause button on the row now toggles pause/play for the current song instead of restarting it.
- New cleaner, bolder shuffle icon.

## 1.0.55
- New proper shuffle icon (two crossing arrows, stroke-based) replacing the X glyph.
- Shuffle button now does a full Fisher-Yates shuffle — every position is random including the first song (was: first song always played first, rest shuffled).
- Tapping a track in playlist/album detail sets the full list as the queue in order, positioned at the tapped song (explicit no-shuffle; same for Favorites and Recents).

## 1.0.56
- Removed the 1.0.53 proactive player-state query on gateway connect: feeding a stale paused snapshot through the snapshot path could arm the pause-yield abandon, which then briefly played audio ("sound for a second"). The abandon still arms on real-time pauses. The underlying stuck-audio-session bug is fixed in the iOS companion (PR JoeyEamigh/bridgething#18); until that ships, force-quit the companion app once to clear a stuck exclusive hold.

## 1.0.57
- Fixed the audio-focus theft: removed the two AUTOMATIC arming paths of the pause-yield abandon (adopting a stale paused track on launch, and the snapshot paused branch). These sent an unsolicited Player::Play 15s after app launch whenever the companion reported a paused Finch track — and every Play grabs the iOS audio session exclusive, interrupting other apps before the zero-length tail finished and released it. The abandon still fires for genuine user-initiated pauses (60s timer via toggle()).

## 1.0.58
- Shuffle button icon replaced with the Phosphor "shuffle-simple" design (user pick from the local icon stash).

## 1.0.59
- "Play on" handoff: choosing a remote session (e.g. Finamp) while Finch has a song playing now tells that session to play the current song and queue, instead of just mirroring whatever the remote client already had.

## 1.0.60
- Detail screen goes compact in portrait: slimmer top bar, smaller hero art (96px), smaller title and buttons, so the track list starts near the top instead of below the fold.

## 1.0.61
- Play-on handoff no longer strands you: the Play command is sent BEFORE pausing local audio, and if the phone link is down it aborts cleanly back to local mode instead of attaching to a dead session.
- Queue restore fix: adopting the live track on restart now brings back the full saved queue when the track belongs to it, instead of collapsing a playlist into one track. Clearing the queue also clears the saved copy.

## 1.0.62
- Auto-advance link stability: the end-of-track watchdog now polls every 2s (was 5s) in the last 10 seconds, so the next track starts faster — a slow end-detect left silence that let iOS suspend the backgrounded companion and drop the link. Auto-advance also skips the play attempt when the link is already down instead of flashing an error; the reconnect handler advances the queue when the link comes back.

## 1.0.63
- Silent-resume fix: after a phone-side pause (interruption, lost audio session), pressing play now does a full track restart from the pause position instead of a resume — resume could report "playing" while the phone's broken audio pipeline output silence.

## 1.0.64
- No more mystery blip: the pause-yield abandon no longer fires while the app is closed/backgrounded (it used to play a second of audio out of nowhere if the WebView was still alive after closing).

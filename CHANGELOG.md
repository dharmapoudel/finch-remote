# Changelog

## 1.4.4

Knob focus ring on "See all" (device photo 1)
- "See all" is now a text link sized to its text (28 px tall, 8 px sides,
  9 px radius) laid out inside its row header. 1.4.3 positioned it with
  absolute + translateY(-50%), and the ring is placed from layout offsets, so
  the ring landed half a button low (over the first tile) and, from
  rounded-full, came out as a big pill. The ring now matches the link exactly
  (0 px error), with the link's own radius, inside the header, overlapping
  nothing. Its touch area stays 44 px (an invisible ::before).
- Every focusable kind was audited with the knob on Home, Playlists, Albums,
  Library, genre / playlist / artist pages, All playlists, Genres and Recent
  tracks (tiles, rows, round buttons, links, the back chevron): ring within
  1.5 px of its target, not clipped, not overlapping a neighbour. The Home
  "Recently added" rows got a 4 px padded box and a 8 px row gap so their
  ring no longer touches the row below.

Top tab strip
- No background, gradient or scrim at all; the art-tinted backdrop shows
  straight through. Labels are kept legible with a text shadow only.
- The strip now overlays the screen instead of pushing it down, so showing,
  hiding or holding a preset (icon reveal) never moves the content.
- New setting (phone settings page): "Hide tab bar until a preset button is
  pressed", config key tabs_autohide (boolean), default ON. When on, the
  strip is hidden and content uses the full height; a preset press shows it
  and it hides 1.5 s after the press (each press restarts that), and it stays
  while a preset is held. Timing and motion copied from Nimbus / Almanac:
  in 450 ms cubic-bezier(0.34,1.36,0.64,1) from 10 px up + transparent, out
  700 ms cubic-bezier(0.4,0,0.2,1); opacity/transform only. When off, the
  strip stays on the four tab screens and reserves its 30 px. The key is read
  live: changing it on the phone applies without a restart.

"See all" rule (item 4)
- A row shows "See all" when it has more than it shows: rails show 5 tiles
  and get See all when the list (or the server's total) is over 5; Home
  "Recently added" shows 4 albums and now gets See all only when the library
  has more than 4 (it always showed it before). Genre pages: 8 albums, See all
  when the genre has more. Rows that fit show no link.

See-all and detail screens (device photos 2, 3)
- No tab strip there. The tall 80 px "< All playlists" bar is now one 36 px
  line: a small back chevron (44 px touch) + the title (+ the count on the
  right). The first grid row starts at y = 42 instead of ~110.
- See-all grids are 4 columns (180 px tiles) instead of 3.
- Album / playlist / artist / genre pages: one 36 px line with a back
  chevron and the kind of page; the title stays in the hero. The page's own
  second backdrop layer is gone (the app backdrop already shows its art), so
  the top of the screen is one surface. Back key / knob and presets work as
  before; a preset press switches tabs (and shows the strip briefly when it
  is auto-hidden).

Now Playing
- Instant mix is a plain icon like shuffle and repeat: same 20 px glyph, same
  off colour, no chip or ring, so it no longer reads as an "on" toggle. The
  button is still 44 x 44 to touch; tap = mix, long press = "Instant mix"
  hint; a press briefly shrinks / dims the glyph. Shuffle and repeat show
  the accent colour only when on; lyrics and heart only when on. The player
  pill keeps its outline (it is the player picker, not a toggle).

Connection drops when a song ends on its own (user report)
- Reproduced on a mock with a Finamp-like player that ends the song itself
  (old track reported paused at its end, then no track for a few seconds,
  then the next one; sparse progress reports) over a slow link model
  (25-64 KB/s, 150 ms latency, one shared pipe, request timeouts honoured).
  Three causes, all fixed:
  1. With another controllable session in the list (a paused web player, a
     TV), Finch re-picked the player while Finamp reported no track and
     jumped to that device for ~5 s ("Playing on Laptop"), then back.
     Now the player Finch picked is kept for 20 s while it reports no track.
  2. If the gap lasted over 6 s, or Finamp reported the old track as paused
     at its end first, Now Playing dropped to "Nothing playing" (and the mini
     player closed). The last track is now held as "Loading next track" for
     up to 15 s, including the paused-at-end case.
  3. The recents reload 4 s after every track change read up to 600 full
     play-history records (~900 KB) for Recent albums. On a slow link the
     session poll queued behind it, passed its 8 s timeout, and Finch showed
     "can't reach server (timeout)". Now:
     - every request goes through one link gate: session polls and commands
       first (never behind more than two others), browsing and artwork at
       most two at a time, and recents reloads, lyrics and the playlist
       index only when nothing else is running or waiting;
     - the recents reload waits 8 s after the change and then for an idle
       link (at most 38 s);
     - its history scan uses lean records (no images, no extra fields), 100
       per page, 300 at most (~45 KB instead of ~900 KB), and the server's
       album-date query is skipped once the server shows it has no dates.
- A single failed or slow poll no longer shows an error: Finch retries after
  1 s, 2 s, 4 s and shows "can't reach server" only after two failures in a
  row.
- Finch polls ~1.5 s after the playhead reaches the end of the song, and
  every 2 s while the player is between tracks, so the next song shows up
  promptly without polling faster the rest of the time.
- Measured on the mock (work/trackend144.mjs): 1.4.3 at 25 KB/s with a long
  history: a 293 KB request held the link 12 s, the poll timed out, error
  shown. 1.4.4: the reload is 44 KB, sent 12.7 s after the change when the
  link was idle, longest wait 1.9 s, no timeouts, no error.

Icon
- New app icon: the open-beak finch on a vinyl record (public/icon.png,
  384 px, 58 KiB). The phone settings page header uses a 96 px copy and the
  setup screen a 192 px copy. The old violet SVG is kept in
  branding/violet-icon-1.0-1.4.3.svg; the 1024 px source is
  branding/open-beak-1024.png.

## 1.4.3

New rows (look from finch-remote, data from Finch's own Jellyfin client)
- Home: Recent tracks, Favorites, Recently added, in that order. Each row has
  See all (Recent tracks opens a paged track list).
- Playlists: Recently played, Favorites, All playlists.
- Albums: Recent albums, Favorites (favorite albums), All albums. (The
  Albums tab's old "Recently added" row is now only on Home.)
- Library: Artists, then Genres (in place of Favorite tracks). Genre tiles
  use the genre's own picture, or one of its albums' covers, or a genre
  placeholder icon. See all opens a paged genre grid. A genre page shows its
  albums (8, with See all) and tracks, with Play, Shuffle, Play next and Mix
  like other pages.
- A row with nothing in it shows its title and one quiet line ("Songs you
  play show up here.") instead of disappearing or looking broken.

Where the data comes from
- Recent tracks: Jellyfin's play history (Audio, Filters=IsPlayed, sorted
  by DatePlayed, newest first). Jellyfin stamps it when the player (Finamp)
  starts a track.
- Recent albums: the server's DatePlayed album sort when it has real dates;
  otherwise the albums of the recent tracks, in order, without repeats.
- Recently played playlists, merged and newest first:
  - playlists you start from Finch (Play, Shuffle, a track in the playlist,
    or the menu), the last 30, kept on the device;
  - playlists the server marks as played (rare);
  - NEW: playlists played anywhere, including Finamp, found in the play
    history. See "Playlist index" below.
- Favorites: favorite tracks / albums from the server; favorite playlists
  as before.
- Genres: MusicGenres for your music library (scoped to it when there is
  exactly one).
- Playlists without a cover show their first track's album cover.
- All of these are cached on the device like the other lists, so every tab
  paints its last rows straight away after a restart. See-all grids keep
  their first page too. Recents reload 4 s after the playing track changes
  (once per burst of skips), not on every poll.

Playlist index (find playlists played in Finamp)
- Jellyfin cannot list the playlists that contain a track, so Finch keeps a
  small index: a 7-character hash of each track id per playlist (about 75 KB
  for 50 playlists x 200 tracks). It is stored on the device and survives
  restarts.
- It is built in the background without crowding the phone link:
  - it starts 75 s after launch;
  - before each request it waits until nothing else is using the link
    (browsing, polls, commands, artwork) and you have not touched the
    screen, knob or buttons for 10 s, and Now Playing is not changing tracks;
  - it makes one request at a time, 1.75 s apart;
  - it uses the ids-only playlist route (Jellyfin 10.9+, about 8 KB per
    200-track playlist). Older servers fall back to 100-track pages;
  - progress is saved after every playlist, and a restart carries on from
    there;
  - a full check runs at most every 6 hours, and otherwise only playlists
    whose track count or last-saved date changed are read again.
- How a playlist counts as played: two of its tracks played within two
  places of each other in the history, at most 20 minutes apart, and from
  different albums. So an album played in order does not count, and neither
  does one track that happens to be in a playlist. If several playlists match
  the same listening session, only the best matches stay. The time shown is
  the newest matching play.
- Measured on the mock (50 playlists x 200 tracks, Jellyfin 10.9+ route):
  - 51 requests and 406 KB in total;
  - about 2.7 minutes after launch while you are not using it (75 s wait +
    50 x 1.77 s);
  - a resumed build after a restart only read the 29 playlists still left;
  - one changed playlist costs 1 request (6 KB).
  On an older server (paged route): 102 requests, 8.6 MB, about 4.2 minutes.

Now Playing
- The player pill shows the cast icon and the client name ("Finamp"),
  without "via". Its touch area is 46 px tall.
- Instant mix is an icon-only pill: 44 x 32 visible, 44 x 44 to touch.
  - Tap starts the mix (toast "Instant mix from <track>").
  - Long press (0.5 s) only shows the "Instant mix" hint.
- The heart is 22 px instead of 26 px. That gives it the same ink size
  (19 x 16.5 px vs 19 x 16.3 px) and the same 2 px stroke as the lyrics icon
  in the transport row.
- Geometry is unchanged, and the morph continuity check passes.

Fixes
- Cached start-up could sit on the cached screens forever. If the daemon
  socket opened before App subscribed to its events (likely when a full
  cached screen paints first), the 'open' event was lost and Finch never
  loaded config or data. App now reads the connection state when it
  subscribes. Present since 1.4.1, and reproduced with the 1.4.2 build in
  the test harness.

Other
- New genre icon (same line style) and an icon audit entry for it.
- Version 1.4.3 (package.json, manifest, reported client version).

## 1.4.2

Volume (as in Finch Remote)
- The knob now always changes your phone's volume through the BridgeThing
  companion app, and the phone shows its own volume overlay. This is the same
  as finch-remote 1.2.1 and commit 97a7a02 (Finch 1.1.135): one volume step
  per knob click, at most one every 90 ms, and the last click of a fast turn
  is never lost. This works on Now Playing, and on other screens when you
  hold the knob (3 seconds of volume control).
- Removed all of Finch's own volume UI:
  - the "Player 42" / "Phone 42" chip on Now Playing
  - the "Knob volume: Phone/Player" button in the Play on sheet
  - the volume pop-up (HUD)
  - the Auto/Phone/Player choice and its saved setting
  - Jellyfin SetVolume
  - the speaker and phone icons
- The help text on the phone settings page now says the knob turns the
  phone's volume.
- Not changed: everything else from 1.3.1's remote logic (polling, the
  playhead clock, shuffle/repeat, optimistic pause and seek).

Now Playing layout
- The shuffle / repeat / Instant mix row has moved down. It now sits just
  above where the seek bar used to be (row at y 284-316; the 1.4.1 bar was at
  y 323).
- The seek bar (with its times) has moved down too, to sit midway between
  that row and the transport row.
- Title, artist and "Playing on" have not moved. All geometry is still fixed,
  so folding full -> mini -> sliver is still transform/opacity only. The
  continuity check passes on two runs.

Sliver stuck at the top of the screen (fixed)
- Cause: when synced lyrics were on (the setting is remembered), the lyrics
  panel stays mounted while Now Playing is folded. It kept the current line
  in view with scrollIntoView({ block: 'center' }), which also scrolls every
  scrollable parent. When folded to the sliver, the current line sits below
  the screen, so the browser scrolled the whole app up by about 476 px. The
  screen went blank and the sliver showed at the top. This happened on app
  open (lyrics on, sliver showing) and whenever the line or track changed
  while folded. Reproduced in 1.4.1: the app root was scrolled by 476 px on
  every cold start.
- Fixes:
  - Lyrics now scroll only their own box, and only while Now Playing is open
    full screen. On unfolding they jump to the current line.
  - The app root and the Now Playing layer use overflow: clip, so no script
    can scroll them.
  - A guard puts any ancestor scroll back to 0 and puts the sheet back to its
    fold position if it is ever off. It runs after every fold, on any scroll
    event and every 3 s. It never interrupts a running fold.
  - The sheet offset is clamped to the screen (0 to 476).
  - A folded sheet with no track renders nothing, instead of a full-screen
    empty state.
  - Lyrics turning on (from the saved setting or a new track's lyrics) never
    opens the sheet or changes the fold.

Sliver: easier to open
- The sliver looks the same (4 px). An invisible touch area now covers the
  bottom 44 px of the screen while the sliver is showing. It sits above the
  lists and backdrop, but below the Play on sheet and menus.
- The touch area uses pointer events with touch-action: none and pointer
  capture, so a list underneath can't take over the gesture once it starts.
- What opens what:
  - A tap opens the mini player.
  - A short flick opens the mini player: 10 px or more upward, done in under
    250 ms or faster than 0.15 px/ms.
  - A slow drag of 20 px or more opens the mini player.
  - Dragging more than half way up opens Now Playing full screen.
  - The sheet follows your finger while you drag.

Accent colour from the album art (fixed)
- Now Playing's transport controls, shuffle/repeat (when on), seek bar and
  mini player take their colour from the cover again. Gold is used only when
  a track has no art.
- Most likely cause (not confirmed on the device): 1.4.1 read the cover's
  colour by fetch()ing the art's blob: URL back. In a webview whose security
  policy (connect-src) does not allow blob:, that fetch is refused, while the
  same art still shows because <img> is allowed. That failure was then
  remembered for good, so the controls fell back to grey and the seek bar to
  gold. Test: 1.4.1 served with such a policy shows exactly that (blocked
  fetches in the console); 1.4.2 shows the cover colour under the same policy.
  Greyscale or very dark covers also fell back to gold in 1.4.1.
- Now the colour is read the way the screen draws the art: an <img> of the
  small 160 px cover, drawn to a 32 px CPU canvas. It is read once per cover
  and remembered across restarts (up to 300 covers). A failed read is retried
  once and is not remembered.
- Greyscale and dark covers get a light neutral tint instead of gold.
- Colours are lightened until they have at least 5:1 contrast on the dark panel.
- On a track change the previous colour stays until the new cover is read,
  then crossfades (300 ms on the controls, 500 ms on the seek bar). Fixed a
  race where the new track could take the previous cover's colour.

Version
- 1.4.2 in package.json, the manifest and the version reported to Jellyfin
  and shown on the settings page.

## 1.4.1

A fix pass on 1.4.0. The look stays finch-remote's; the speed and the way
things work come back from Finch 1.3.1.

Cache that survives a restart (new)
- Album art is now saved on the Car Thing (IndexedDB in the app's webview),
  keyed by item:image-tag:size, up to 12 MiB / 900 images (less if the
  webview grants under 48 MiB). The least recently used ones go first; one
  image over 512 KiB is never kept. After a restart art shows straight away,
  with no new image downloads.
- The last-loaded Home, Playlists, Albums and Library lists and the last 60
  detail-page track lists are saved too (max 256 KiB each). Screens paint
  from them as soon as the app opens, even before the BridgeThing daemon
  answers, then refresh in the background.
- The lists are also mirrored, in one small value (max 192 KiB), to the
  daemon's own key-value store, in case the webview's storage is wiped.
- If storage is unavailable or full, Finch carries on as before, keeping
  art in memory only.

Now Playing morph (rewritten)
- Folding full -> mini player -> sliver and back no longer resizes anything
  mid-animation. Every element keeps one fixed layout; only position, scale
  and opacity animate, with 1.3.1's 380 ms ease-out.
- The album art is one shared element that scales from the big panel onto
  the mini player's thumbnail. The song title flies and shrinks into the mini
  title's place, crossfading with it. Everything else fades.
- Dragging with a finger follows the finger the same way. Finch starts with
  the sliver already in place (no slide on launch).
- No blurs are animated during the fold. The Now Playing backdrop is a
  pre-blurred image, not a live blur.

Knob selection indicator (from 1.3.1)
- Turning the knob shows 1.3.1's highlight again: one tinted panel with a
  thin ring and an accent bar on the left. It glides from row to row and the
  selected row's text nudges right. Tiles get an accent ring around the art.
  Uses 1.3.1's smooth scroll-into-view (nearest).
- One knob click = one song in track lists, as in 1.3.1. A row's play and ⋮
  buttons are touch-only now, so they no longer add extra knob stops.

Instant mix (as in 1.3.1)
- Now Playing has a labelled "Instant mix" pill again. It mixes from the
  playing track and is disabled while the next track loads.
- Album and playlist pages have a labelled "Mix" button again (1.3.1's
  label). Artist pages keep "Instant mix". The ⋮ menus keep "Start instant mix".
- Same 1.3.1 function: it plays the mix, shows the toast "Instant mix from
  <name>" and opens Now Playing.

Smoother on the Car Thing
- Session polls no longer re-render every tile and row. The browse screens
  only update when the playing track, pause state or favorites change, as in
  1.3.1. The 500 ms playhead tick no longer re-renders the screens.
- The seek bar runs no per-frame JavaScript. It updates twice a second and
  the compositor moves it smoothly in between. The running sheen and halo
  loops are gone. The clock ticks once a second, and lyrics only re-render
  when the line changes.
- Backdrops are pre-blurred once per album cover into a 36 px image (1.3.1's
  trick), instead of a live 64 px CSS blur over a 1.5x full-screen image.
  Menus, the Play on sheet and the volume pop-up are solid "glass" panels
  with no backdrop-filter blur or SVG filter.
- Removed the unused WebGL shader module. The volume pop-up animates with
  transform, not width. View entry no longer scales the page (sharp text).
- Measured with headless Chromium over 6 s idle, compared with 1.4.0:
  - Home: 12 layouts (was 103).
  - Now Playing: 12 layouts and 53 ms of main-thread work (was 116 and 311 ms).
  - A full -> mini fold: 5 layouts (was 27).

Icons (audit)
- One icon family everywhere, using 1.3.1's line glyphs (24 px grid, about
  2 px stroke at every size). Transport controls, the filled heart and ⋮
  stay solid. Fixes:
  - Instant mix had a broken glyph.
  - Lyrics looked like an "align text" icon.
  - The favorite heart looked filled even when off.
  - "Go to album" / "Open" used the library grid.
  - Now Playing's next and previous were fast-forward and rewind arrows.
  - The album page's Shuffle was drawn differently from shuffle elsewhere.
  - Every art placeholder was a music note: albums, playlists and artists now
    have their own.
  - "Play next" and "Add to queue" now have distinct icons.
  - The "via <app>" pill and "Play on…" button now show the cast icon.
  - "See all" now has a chevron.
  - A playing device's row in the Play on sheet now shows the cast icon with
    playing bars.
- See Finch-1.4.1-icon-audit.png. App icon unchanged.

Unchanged
- Manifest id, app name, icon, config keys, sign-in, settings page.
- All 1.3.1 remote/sync logic: polling, playhead clock, volume, overrides.

## 1.4.0

New look: the on-screen design and interaction of Finch Remote (finch-remote
1.2.1), applied to this Finch. Only the UI changed. Remote control, sync,
volume, sign-in and settings keys work exactly as in 1.3.1, so an installed
1.3.1 stays signed in after the update.

Look and navigation
- Top tab strip under the four preset buttons: HOME, PLAYLISTS, ALBUMS,
  LIBRARY in small spaced capitals with an accent underline; holding a button
  drops its icon in. Replaces the 1.3.1 tabs (Playing / Library / Players / Favorite).
- Outfit everywhere (Inter dropped), Noto Sans Devanagari bundled for titles and lyrics.
- Each screen tints a blurred album-art backdrop with the cover's accent colour.
- Home: Favorite tracks rail, Recently added albums. Playlists: Favorite
  playlists, All playlists. Albums: Recently added, All albums. Library:
  Artists rail, Favorite tracks list. Rails show five square tiles with a ⋮
  menu and a "See all" link to a full grid or list (paged as before).
- Detail pages: large art, accent Play pill, Shuffle, Play next, Instant mix
  and Favorite buttons, numbered track list with per-row play/pause and ⋮.
  Artist pages show an album grid and an Instant mix button.
- Context menus as glass bottom sheets: Play next, Add to queue (new:
  queues at the end), favorite, Start instant mix, Go to album / Open.
- Now Playing in the split layout: art left; clock, "via <client>" pill,
  title, artist, "Playing on <device>", accent seek bar with times, and the
  lyrics / previous / play-pause / next / heart row. Shuffle, repeat, Instant
  mix and the knob volume chip sit in a small row above the seek bar.
- Now Playing folds into a mini player (drag down or press Back), then a 4px
  sliver; tap either to bring it back. When something is playing Finch starts
  with the sliver showing.
- "Play on" sheet lists the Jellyfin sessions (replaces the Players screen).
  Remote only: there is no "This device" entry.
- Synced lyrics in finch-remote's style over the blurred art (current line
  highlighted, tap a line to seek); the lyrics on/off choice is still remembered.
- Glass volume HUD and toasts.
- Phone settings page restyled to finch-remote's look (dark surface,
  coral-to-magenta buttons and tabs). Same sign-in flows and config keys
  (server_url, username, access_token, user_id, device_id); the help text
  describes the new controls.

Controls
- Presets 1-4 switch tabs. Hold 1 = Now Playing, hold 3 = Play on, hold 4 =
  favorite the playing track (the 1.3.1 preset actions, now on long presses).
- The knob moves a highlight through the screen and its press opens the
  highlighted item; on Now Playing the knob turns volume and the press plays
  or pauses. Holding the knob on a browse screen gives 3 seconds of volume control.
- Back closes the top sheet, folds Now Playing, then leaves detail pages.

Kept from 1.3.1 (unchanged code)
- Session polling every 2 s on Now Playing, 5 s elsewhere; playhead anchored
  to the first poll that sees each new reported position; optimistic
  pause/seek/volume holds; loading state between tracks.
- Knob volume: 4% per detent, sent 180 ms after the last turn, to the player
  (SetVolume) or the phone per the Auto / Phone / Player choice; the level
  shown is the last one sent. No automatic switch to the phone.
- Jellyfin client, Instant mix, favorites, queue/play-next, lyrics loading,
  artwork loader, manifest id, app name, icon.

Not carried over from finch-remote
- On-device playback ("This device"), its player, queue persistence,
  art caching tiers, websocket, settings sign-in code and icon: this Finch keeps its own.
- Queue sheet: Jellyfin does not give a remote reliable access to Finamp's
  queue, so there is no queue view (the queue button slot holds the lyrics toggle, as in finch-remote).
- Recently played tracks/playlists rails and Genres: this Finch does not fetch that data.
- Search / on-screen keyboard (neither app has it on screen).

Build
- The app and settings builds and `npm run share` now fail when the bundle
  breaks a device limit: icon over 64 KiB, settings page over 1 MiB, overlay
  over 512 KiB (scripts/limits.ts). No source maps in the build.
- Version 1.4.0 in package.json, manifest and the Jellyfin client header.
- Demo mode: `?demo&view=` now takes home, playlists, albums, library,
  favorites, detail, artist, playlist, albumlist, now, lyrics, playon, mini.

## 1.3.1

- Playhead anchored to the first poll that sees each reported position
  (Finamp reports position/volume about every 150 s).
- Volume UI shows the last level sent.
- No automatic fallback to the phone's volume.

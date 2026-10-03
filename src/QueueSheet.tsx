import { useRef } from 'react';
import { Artwork, Icon, IconBtn, useArt, useArtAccent, usePlayer } from './components';
import { player } from './player';
import { FocusScope } from './fx/focus';
import { GlassPanel } from './fx/shaders';

// The small, almost-transparent bar at the bottom center of every screen
// while a song is playing. Swipe up (or tap) opens the queue sheet.
export function QueueHandle({ onOpen }: { onOpen: () => void }) {
  const startY = useRef<number | null>(null);
  return (
    <button
      type="button"
      data-focusable
      aria-label="Open queue"
      onClick={onOpen}
      onTouchStart={e => {
        startY.current = e.touches[0].clientY;
      }}
      onTouchEnd={e => {
        const s = startY.current;
        startY.current = null;
        if (s !== null && s - e.changedTouches[0].clientY > 50) onOpen();
      }}
      className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 px-3 pt-2 pb-1"
    >
      <div data-glow-target className="h-1 w-12 rounded-full bg-white/20 shadow-[0_0_8px_rgba(0,0,0,0.8)]" />
    </button>
  );
}

// Queue as a bottom sheet over the whole app. Drag down anywhere on the
// panel (or tap the backdrop) to close — no close button. Tapping the
// now-playing card opens the Now Playing screen.
export function QueueSheet({ onClose, onOpenNowPlaying }: { onClose: () => void; onOpenNowPlaying: () => void }) {
  usePlayer();
  const art = useArt();
  const upcoming = player.queue.slice(player.index + 1);
  const current = player.current();
  // the now-playing card picks up the track's art color
  const npArt = current && art ? (art.trackArt(current, 160) ?? null) : null;
  const npAccent = useArtAccent(npArt);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startY: number; dy: number; active: boolean } | null>(null);

  const setDragOffset = (dy: number, animate: boolean): void => {
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!sheet) return;
    sheet.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    if (backdrop) backdrop.style.opacity = dy > 0 ? String(Math.max(0, 1 - dy / 500)) : '';
  };

  return (
    <FocusScope>
      <div className="absolute inset-0 z-30">
        <button
          ref={backdropRef}
          type="button"
          data-focusable
          data-glow="none"
          aria-label="Close queue"
          onClick={onClose}
          className="absolute inset-0 bg-black/50"
        />
        <div
          ref={sheetRef}
          className="absolute inset-x-0 bottom-0 top-[10%] overflow-hidden rounded-t-3xl"
          onTouchStart={e => {
          // A drag that starts in the track list only becomes a sheet drag
          // when the list is already scrolled to the top; otherwise the list
          // keeps scrolling normally.
          const list = listRef.current;
          const inList = !!list && list.contains(e.target as Node);
          drag.current = {
            startY: e.touches[0].clientY,
            dy: 0,
            active: !inList || (list?.scrollTop ?? 0) <= 0,
          };
        }}
        onTouchMove={e => {
          const d = drag.current;
          if (!d?.active) return;
          const dy = e.touches[0].clientY - d.startY;
          d.dy = Math.max(0, dy);
          setDragOffset(d.dy, false);
        }}
        onTouchEnd={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.active && d.dy > 110) {
            onClose();
          } else {
            setDragOffset(0, true);
          }
        }}
        onTouchCancel={() => {
          drag.current = null;
          setDragOffset(0, true);
        }}
      >
        <GlassPanel className="flex h-full flex-col">
        <div className="shrink-0 px-6 pt-3 pb-1">
          <div className="mx-auto h-1.5 w-16 rounded-full bg-white/30" />
        </div>
        <div className="flex shrink-0 items-center justify-between px-6 py-2">
          <h2 className="text-2xl font-bold">Up next{upcoming.length ? ` (${upcoming.length})` : ''}</h2>
          {upcoming.length ? (
            <button
              type="button"
              data-focusable
              onClick={() => player.clearQueue()}
              className="h-12 rounded-full bg-white/10 px-5 text-lg text-red-300 active:bg-white/20"
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" ref={listRef}>
          {current ? (
            <div
              className={`mb-2 flex items-center gap-3 rounded-2xl p-2 ${npAccent ? '' : 'bg-leaf/10'}`}
              style={npAccent ? { backgroundColor: `color-mix(in srgb, ${npAccent} 16%, transparent)` } : undefined}
            >
              <button
                type="button"
                data-focusable
                onClick={onOpenNowPlaying}
                aria-label={`Open Now Playing for ${current.name}`}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left active:bg-white/8"
              >
                <Artwork
                  src={art?.trackArt(current, 160) ?? null}
                  size={56}
                  rounded="rounded-lg"
                  label={current.album}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xl font-medium text-leaf">{current.name}</span>
                  <span className="block truncate text-base text-white/50">
                    Now playing · {current.artist}
                  </span>
                </span>
              </button>
              <IconBtn size={56} label={player.intentPlaying ? 'Pause' : 'Play'} onClick={() => void player.toggle()}>
                <Icon name={player.intentPlaying ? 'pause' : 'play'} size={28} />
              </IconBtn>
            </div>
          ) : null}
          {upcoming.length === 0 ? (
            <div className="flex items-center justify-center px-8 py-10 text-center text-xl text-white/40">
              {current ? 'The queue ends here.' : 'The queue is empty. Play something from your library.'}
            </div>
          ) : (
            upcoming.map((t, i) => {
              const qi = player.index + 1 + i;
              return (
                <div
                  key={`${t.id}-${qi}`}
                  className="flex min-h-16 items-center gap-3 rounded-xl px-2 py-1.5 active:bg-white/8"
                >
                  <button
                    type="button"
                    data-focusable
                    onClick={() => void player.jumpTo(qi)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Artwork src={art?.trackArt(t, 160) ?? null} size={52} rounded="rounded-lg" label={t.album} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xl leading-tight">{t.name}</span>
                      <span className="block truncate text-base leading-tight text-white/50">{t.artist}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    data-focusable
                    aria-label={`Remove ${t.name} from queue`}
                    onClick={() => player.removeAt(qi)}
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white/50 active:bg-white/15"
                  >
                    <Icon name="x" size={26} />
                  </button>
                </div>
              );
            })
          )}
          </div>
        </GlassPanel>
        </div>
      </div>
    </FocusScope>
  );
}

import { useRef } from 'react';
import { Artwork, Icon, IconBtn, ProgressBar, useArt, usePlayer } from './components';
import { player } from './player';

export type MiniState = 'hidden' | 'mini' | 'sliver';

// The 2px sliver: the exact same ProgressBar (gold fill, sheen, RAF-driven),
// no halo dot, clipped to 2px. Swipe/flick up (or tap) expands to the mini bar.
export function SeekSliver({ onExpand }: { onExpand: () => void }) {
  usePlayer();
  const t = player.current();
  const swipeRef = useRef<{ startY: number; startT: number } | null>(null);

  if (!t) return null;

  const onTouchStart = (e: React.TouchEvent): void => {
    swipeRef.current = { startY: e.touches[0].clientY, startT: Date.now() };
  };
  const onTouchEnd = (e: React.TouchEvent): void => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s) return;
    const endY = e.changedTouches[0].clientY;
    const dy = endY - s.startY;
    const dt = Math.max(1, Date.now() - s.startT);
    const velocity = -dy / dt; // px/ms upward
    // Swipe up, flick up, or tap → expand to mini bar.
    if (dy < -40 || velocity > 0.5 || Math.abs(dy) < 10) {
      onExpand();
    }
  };

  return (
    <div
      role="button"
      aria-label="Expand mini player"
      onClick={onExpand}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="absolute inset-x-0 bottom-0 z-30 h-4 cursor-pointer"
    >
      {/* Clip the 3px ProgressBar track to 2px — same gold, sheen, animation */}
      <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
        <div className="h-[3px] w-full">
          <ProgressBar onSeek={ms => void player.seekTo(ms)} dot={false} />
        </div>
      </div>
    </div>
  );
}

// The mini player bar: 20px seekbar on top, then artwork + title/artist +
// transport controls. Drag/swipe down collapses to the 2px sliver; tap
// (outside the buttons) expands to full Now Playing.
export function MiniBar({ onExpand, onCollapse }: { onExpand: () => void; onCollapse: () => void }) {
  usePlayer();
  const art = useArt();
  const t = player.current();
  const playing = player.intentPlaying && !player.loading;
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);
  const swipeRef = useRef<{ startY: number; startT: number } | null>(null);

  if (!t) return null;

  const onTouchStart = (e: React.TouchEvent): void => {
    const p = e.touches[0];
    dragRef.current = { startY: p.clientY, dy: 0 };
    swipeRef.current = { startY: p.clientY, startT: Date.now() };
    const el = barRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.willChange = 'transform, opacity';
    }
  };
  const onTouchMove = (e: React.TouchEvent): void => {
    const d = dragRef.current;
    const el = barRef.current;
    if (!d || !el) return;
    const p = e.touches[0];
    const dy = p.clientY - d.startY;
    d.dy = dy;
    // Drag down → collapse to sliver. Up is swipe/flick only (no drag).
    if (dy > 0) {
      el.style.transform = `translateY(${dy}px)`;
      const progress = Math.min(1, dy / 120);
      el.style.opacity = String(1 - progress * 0.4);
    }
  };
  const onTouchEnd = (e: React.TouchEvent): void => {
    const d = dragRef.current;
    const s = swipeRef.current;
    const el = barRef.current;
    dragRef.current = null;
    swipeRef.current = null;
    if (!d || !el) return;
    const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transition = `transform 0.28s ${ease}, opacity 0.28s ${ease}`;
    el.style.willChange = 'auto';

    // Swipe/flick up detection: velocity or distance threshold.
    if (s) {
      const endY = e.changedTouches[0].clientY;
      const dy = endY - s.startY;
      const dt = Math.max(1, Date.now() - s.startT);
      const velocity = -dy / dt; // px/ms upward
      if (dy < -40 || velocity > 0.5) {
        // Swipe/flick up → expand to fullscreen (animated).
        onExpand();
        return;
      }
    }

    if (d.dy > 50) {
      // Dragged down: snap to sliver.
      el.style.transform = 'translateY(100%)';
      el.style.opacity = '0';
      window.setTimeout(() => onCollapse(), 260);
    } else {
      el.style.transform = 'translateY(0px)';
      el.style.opacity = '1';
    }
  };

  return (
    <div
      ref={barRef}
      className="absolute inset-x-0 bottom-0 z-30 select-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Semi-transparent dark tint covering the whole bar, seekbar included */}
      <div className="bg-black/55 backdrop-blur-md">
        {/* 20px seekbar strip on top — identical ProgressBar, no halo dot */}
        <div className="flex h-5 w-full items-center px-4">
          <ProgressBar onSeek={ms => void player.seekTo(ms)} dot={false} />
        </div>
        {/* transport row */}
        <div
          className="flex items-center gap-3 px-4 py-2"
          onClick={e => {
            // tap outside buttons expands; buttons stop propagation
            if ((e.target as HTMLElement).closest('button')) return;
            onExpand();
          }}
        >
          <Artwork
            src={art?.trackArt(t) ?? null}
            size={44}
            rounded="rounded-md"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium text-white">{t.name}</div>
            <div className="truncate text-sm text-white/60">{t.artist}</div>
          </div>
          <IconBtn
            size={48}
            label={playing ? 'Pause' : 'Play'}
            onClick={() => void player.toggle()}
          >
            <Icon name={playing ? 'pause' : 'play'} size={24} />
          </IconBtn>
          <IconBtn size={48} label="Next" onClick={() => void player.next()}>
            <Icon name="next" size={24} />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

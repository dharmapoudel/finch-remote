import { useEffect, useRef, useState } from 'react';
import { Artwork, Icon, IconBtn, ProgressBar, useArt, usePlayer } from './components';
import { player } from './player';

export type MiniState = 'hidden' | 'mini' | 'sliver';

// The 2px progress sliver at the very bottom. Tap (or swipe up) expands to
// the mini bar.
export function SeekSliver({ onExpand }: { onExpand: () => void }) {
  usePlayer();
  const [, setTick] = useState(0);
  const t = player.current();
  const playing = player.intentPlaying && !player.loading;

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setTick(x => x + 1), 500);
    return () => window.clearInterval(id);
  }, [playing, t?.id]);

  if (!t) return null;
  const dur = player.trackDurationMs || t.durationMs || 0;
  const pos = Math.min(player.positionNow(), dur);
  const ratio = dur > 0 ? pos / dur : 0;

  const startY = useRef<number | null>(null);
  return (
    <div
      role="button"
      aria-label="Expand mini player"
      onClick={onExpand}
      onTouchStart={e => {
        startY.current = e.touches[0].clientY;
      }}
      onTouchEnd={e => {
        const s = startY.current;
        startY.current = null;
        if (s === null) return;
        const dy = e.changedTouches[0].clientY - s;
        // swipe up expands too
        if (s - e.changedTouches[0].clientY > 40) onExpand();
        else if (Math.abs(dy) < 10) onExpand();
      }}
      className="absolute inset-x-0 bottom-0 z-30 h-4 cursor-pointer"
    >
      <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/15">
        <div
          className="h-full bg-white/70 transition-[width] duration-500"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
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

  if (!t) return null;

  const onTouchStart = (e: React.TouchEvent): void => {
    const p = e.touches[0];
    dragRef.current = { startY: p.clientY, dy: 0 };
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
    const dy = Math.max(0, p.clientY - d.startY);
    d.dy = dy;
    el.style.transform = `translateY(${dy}px)`;
    const progress = Math.min(1, dy / 120);
    el.style.opacity = String(1 - progress * 0.6);
  };
  const onTouchEnd = (): void => {
    const d = dragRef.current;
    const el = barRef.current;
    dragRef.current = null;
    if (!d || !el) return;
    el.style.transition =
      'transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.28s cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.willChange = 'auto';
    if (d.dy > 50) {
      // Snap down to the sliver.
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
      {/* 20px seekbar strip on top — identical to fullscreen ProgressBar */}
      <div className="flex h-5 w-full items-center px-4">
        <ProgressBar onSeek={ms => void player.seekTo(ms)} />
      </div>
      {/* transport row */}
      <div
        className="flex items-center gap-3 bg-zinc-950/95 px-4 py-2 backdrop-blur"
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
  );
}

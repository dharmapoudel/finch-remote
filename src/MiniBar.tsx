import { useEffect, useRef, useState } from 'react';
import { Artwork, Icon, IconBtn, useArt, usePlayer } from './components';
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
  const [, setTick] = useState(0);
  const t = player.current();
  const playing = player.intentPlaying && !player.loading;
  const startY = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setTick(x => x + 1), 500);
    return () => window.clearInterval(id);
  }, [playing, t?.id]);

  if (!t) return null;
  const dur = player.trackDurationMs || t.durationMs || 0;
  const pos = Math.min(player.positionNow(), dur);
  const ratio = dur > 0 ? pos / dur : 0;

  const seekTo = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    void player.seekTo(ratio * dur);
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-30 select-none"
      onTouchStart={e => {
        const p = e.touches[0];
        startY.current = { x: p.clientX, y: p.clientY };
      }}
      onTouchEnd={e => {
        const s = startY.current;
        startY.current = null;
        if (!s) return;
        const p = e.changedTouches[0];
        const dy = p.clientY - s.y;
        const dx = p.clientX - s.x;
        // swipe down collapses to the sliver
        if (dy > 60 && Math.abs(dx) < 80) {
          onCollapse();
        }
      }}
    >
      {/* 20px seekbar strip on top — tap/drag to seek */}
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(pos)}
        className="relative h-5 w-full cursor-pointer"
        onClick={e => seekTo(e.clientX, e.currentTarget)}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-white/15">
          <div className="h-full bg-white/70" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
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

// "Play on": finch-remote's device sheet, listing the Jellyfin sessions Finch
// already polls (Finch 1.3.1's Players screen, folded into the sheet). Remote
// only: there is no "This device" row, the Car Thing never plays audio.
import { useRef } from 'react';
import type { Session } from '../jellyfin';
import { FocusScope } from '../fx/focus';
import { GlassPanel } from '../fx/glass';
import { Icon } from './components';
import { usePb } from './playback';

function sessionLine(s: Session): string {
  if (s.NowPlayingItem) return `${s.PlayState?.IsPaused ? 'Paused' : 'Playing'} · ${s.NowPlayingItem.Name}`;
  return s.UserName ? `Idle · ${s.UserName}` : 'Idle';
}

export function PlayOnSheet({ onClose }: { onClose: () => void }) {
  const pb = usePb();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; dy: number; startT: number } | null>(null);
  const onDragStart = (e: React.TouchEvent): void => {
    dragRef.current = { startY: e.touches[0].clientY, dy: 0, startT: Date.now() };
  };
  const onDragMove = (e: React.TouchEvent): void => {
    const d = dragRef.current;
    if (!d || !sheetRef.current) return;
    const dy = Math.max(0, e.touches[0].clientY - d.startY);
    d.dy = dy;
    sheetRef.current.style.transition = 'none';
    sheetRef.current.style.transform = `translateY(${dy}px)`;
  };
  const onDragEnd = (): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !sheetRef.current) return;
    if (d.dy > 120 || (d.dy > 24 && Date.now() - d.startT < 300)) onClose();
    else {
      sheetRef.current.style.transition = 'transform 0.25s ease-out';
      sheetRef.current.style.transform = 'translateY(0)';
    }
  };

  const row = 'flex w-full items-center gap-4 rounded-2xl px-4 py-4 text-left active:bg-white/10';
  const current = pb.target;

  return (
    <FocusScope>
      <div
        className="pointer-events-auto absolute inset-0 z-[60]"
        onTouchStart={e => e.stopPropagation()}
        onTouchMove={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
      >
        <button
          type="button"
          data-focusable
          data-glow="none"
          aria-label="Close device picker"
          onClick={onClose}
          className="absolute inset-0 bg-black/50"
        />
        <div ref={sheetRef} className="absolute inset-x-0 top-[18%] bottom-0 overflow-hidden rounded-t-3xl">
          <GlassPanel className="flex h-full flex-col">
            <div
              className="flex shrink-0 items-center justify-between px-6 py-5"
              onTouchStart={onDragStart}
              onTouchMove={onDragMove}
              onTouchEnd={onDragEnd}
            >
              <div className="text-2xl font-bold">Play on</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
              {!pb.sessionsLoaded ? (
                <div className="flex items-center justify-center py-10">
                  <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/15 border-t-gold" />
                </div>
              ) : pb.sessions.length === 0 ? (
                <div className="px-4 py-6 text-center text-xl leading-snug text-white/50">
                  {pb.pollError
                    ? `Can't reach Jellyfin: ${pb.pollError}`
                    : 'No players found. Open Jellyfin or Finamp on your phone, TV or computer, signed in to the same account.'}
                </div>
              ) : (
                pb.sessions.map(s => {
                  const on = current?.Id === s.Id;
                  const playing = !!s.NowPlayingItem && !s.PlayState?.IsPaused;
                  return (
                    <button
                      key={s.Id}
                      type="button"
                      data-focusable
                      data-focus-default={on ? true : undefined}
                      data-sel="row"
                      onClick={() => {
                        pb.act.chooseTarget(s);
                        onClose();
                      }}
                      className={row}
                    >
                      <span className={`relative shrink-0 ${playing ? 'text-leaf' : 'text-white/60'}`}>
                        <Icon name="cast" size={28} />
                        {playing ? (
                          <span className="eq absolute -right-1.5 -bottom-1 scale-75">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xl font-semibold">
                          {s.Client} <span className="font-normal text-white/45">· {s.DeviceName}</span>
                        </div>
                        <div className="truncate text-lg text-white/45">{sessionLine(s)}</div>
                      </div>
                      {on ? <Icon name="check" size={26} className="shrink-0 text-leaf" /> : null}
                    </button>
                  );
                })
              )}
              <div className="px-4 pt-4 text-lg leading-snug text-white/35">
                Audio plays in the app you pick and Finch is the remote: transport, seek and what to play all drive that
                player. The knob turns your phone's volume. Only players that allow remote control are listed.
              </div>
            </div>
          </GlassPanel>
        </div>
      </div>
    </FocusScope>
  );
}

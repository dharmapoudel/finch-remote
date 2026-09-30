import { Artwork, Empty, Icon, IconBtn, TopBar, useArt, usePlayer } from '../components';
import { player } from '../player';
import type { ViewProps } from '../nav';

export default function Queue({ back }: ViewProps) {
  usePlayer();
  const art = useArt();
  const upcoming = player.queue.slice(player.index + 1);
  const current = player.current();

  return (
    <div className="flex h-full flex-col">
      <TopBar
        title={`Up next${upcoming.length ? ` (${upcoming.length})` : ''}`}
        onBack={back}
        right={
          upcoming.length ? (
            <button
              type="button"
              onClick={() => player.clearQueue()}
              className="h-14 rounded-full bg-white/10 px-5 text-xl text-red-300 active:bg-white/20"
            >
              Clear
            </button>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {current ? (
          <div className="mb-2 flex items-center gap-3 rounded-2xl bg-leaf/10 p-2">
            <Artwork src={art?.trackArt(current, 160) ?? null} size={56} rounded="rounded-lg" label={current.album} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-medium text-leaf">{current.name}</div>
              <div className="truncate text-base text-white/50">Now playing · {current.artist}</div>
            </div>
            <IconBtn size={56} label={player.intentPlaying ? 'Pause' : 'Play'} onClick={() => void player.toggle()}>
              <Icon name={player.intentPlaying ? 'pause' : 'play'} size={28} />
            </IconBtn>
          </div>
        ) : null}
        {upcoming.length === 0 ? (
          <Empty text={current ? 'The queue ends here.' : 'The queue is empty. Play something from your library.'} />
        ) : (
          upcoming.map((t, i) => {
            const qi = player.index + 1 + i;
            return (
              <div key={`${t.id}-${qi}`} className="flex min-h-16 items-center gap-3 rounded-xl px-2 py-1.5 active:bg-white/8">
                <button
                  type="button"
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
    </div>
  );
}

// Demo-only icon audit sheet (?demo&view=icons): every icon Finch shows,
// grouped by screen, at the exact size it renders there plus a 2x close-up.
import { Icon, type IconName } from './components';

type Use = { where: string; icon: IconName; size: number; note?: string };

const GROUPS: { title: string; uses: Use[] }[] = [
  {
    title: 'Top tabs (shown while a preset is held)',
    uses: [
      { where: 'Home', icon: 'home', size: 24 },
      { where: 'Playlists', icon: 'playlist', size: 24 },
      { where: 'Albums', icon: 'album', size: 24 },
      { where: 'Library', icon: 'library', size: 24 },
    ],
  },
  {
    title: 'Now Playing',
    uses: [
      { where: 'Lyrics', icon: 'lyrics', size: 26 },
      { where: 'Previous', icon: 'prev', size: 32 },
      { where: 'Play', icon: 'play', size: 40 },
      { where: 'Pause', icon: 'pause', size: 40 },
      { where: 'Next', icon: 'next', size: 32 },
      { where: 'Favorite (off)', icon: 'heart', size: 22 },
      { where: 'Favorite (on)', icon: 'heartFill', size: 22 },
      { where: 'Shuffle', icon: 'shuffle', size: 20 },
      { where: 'Repeat all', icon: 'repeat', size: 20 },
      { where: 'Repeat one', icon: 'repeatOne', size: 20 },
      { where: 'Instant mix pill (icon only; hold = hint)', icon: 'mix', size: 18 },
      { where: 'Player pill: Play on', icon: 'cast', size: 16 },
    ],
  },
  {
    title: 'Mini player',
    uses: [
      { where: 'Previous', icon: 'prev', size: 26 },
      { where: 'Play / Pause', icon: 'play', size: 32 },
      { where: 'Pause', icon: 'pause', size: 32 },
      { where: 'Next', icon: 'next', size: 26 },
    ],
  },
  {
    title: 'Detail page actions',
    uses: [
      { where: 'Play pill', icon: 'play', size: 26 },
      { where: 'Shuffle play', icon: 'shuffle', size: 26 },
      { where: 'Play next', icon: 'playNext', size: 26 },
      { where: 'Mix (Instant mix)', icon: 'mix', size: 24 },
      { where: 'Favorite (off)', icon: 'heart', size: 26 },
      { where: 'Favorite (on)', icon: 'heartFill', size: 26 },
    ],
  },
  {
    title: 'Context menus (⋮)',
    uses: [
      { where: 'Play album / playlist', icon: 'play', size: 28 },
      { where: 'Shuffle album', icon: 'shuffle', size: 28 },
      { where: 'Play next', icon: 'playNext', size: 28 },
      { where: 'Add to queue', icon: 'queueAdd', size: 28 },
      { where: 'Add to favorites', icon: 'heart', size: 28 },
      { where: 'Remove from favorites', icon: 'heartFill', size: 28 },
      { where: 'Start instant mix', icon: 'mix', size: 28 },
      { where: 'Go to / Open album', icon: 'album', size: 28 },
      { where: 'Open playlist', icon: 'playlist', size: 28 },
      { where: 'Open artist', icon: 'artist', size: 28 },
      { where: 'Open genre', icon: 'genre', size: 28 },
      { where: 'Cancel', icon: 'x', size: 26 },
    ],
  },
  {
    title: 'Lists, tiles, navigation',
    uses: [
      { where: 'Row play', icon: 'play', size: 26 },
      { where: 'Row pause', icon: 'pause', size: 26 },
      { where: 'More options ⋮', icon: 'dots', size: 26 },
      { where: 'Back', icon: 'back', size: 30 },
      { where: 'See all', icon: 'chevronRight', size: 20 },
    ],
  },
  {
    title: 'Art placeholders (no cover)',
    uses: [
      { where: 'Album', icon: 'album', size: 50 },
      { where: 'Playlist', icon: 'playlist', size: 50 },
      { where: 'Artist', icon: 'artist', size: 50 },
      { where: 'Track', icon: 'note', size: 50 },
      { where: 'Genre', icon: 'genre', size: 50 },
    ],
  },
  {
    title: 'Play on sheet, empty states',
    uses: [
      { where: 'Player row', icon: 'cast', size: 28 },
      { where: 'Current player', icon: 'check', size: 26 },
      { where: 'No players', icon: 'cast', size: 84 },
      { where: 'Nothing playing', icon: 'note', size: 84 },
      { where: 'No lyrics', icon: 'lyrics', size: 56 },
    ],
  },
];

export default function IconAudit() {
  return (
    <div className="h-full w-full overflow-y-auto bg-zinc-950 p-4 text-white">
      <div className="mb-3 text-xl font-semibold">Finch 1.4.3 icon audit</div>
      {GROUPS.map(g => (
        <section key={g.title} className="mb-4">
          <h2 className="mb-2 text-xs font-semibold tracking-[0.2em] text-white/60 uppercase">{g.title}</h2>
          <div className="grid grid-cols-6 gap-2">
            {g.uses.map(u => (
              <div key={g.title + u.where} className="flex flex-col items-center gap-1 rounded-xl bg-white/6 p-2">
                <div className="flex h-24 w-full items-center justify-around">
                  <Icon name={u.icon} size={Math.min(u.size, 84)} className="text-white" />
                  {u.size <= 40 ? <Icon name={u.icon} size={u.size * 2} className="text-goldlight" /> : null}
                </div>
                <div className="w-full truncate text-center text-[11px] leading-tight text-white/80">{u.where}</div>
                <div className="font-mono text-[10px] text-white/40">
                  {u.icon} · {u.size}px
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

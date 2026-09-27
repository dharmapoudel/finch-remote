// Shared gate for ALL phone-tunnel traffic (net.fetch JSON, artwork, remote
// commands). The iPhone companion buffers each net.fetch reply fully before
// sending it back as a single gateway message; firing ~9 concurrent fetches
// on app load wedges the companion and stalls the Bluetooth link. This
// semaphore caps total concurrent tunneled requests at 3 — JSON, art, and
// commands all draw from the same pool, so the phone is never asked to
// juggle more than 3 in flight. FIFO, except 'front' priority jumps the
// queue (user-initiated commands and on-screen art beat background work).
const MAX_CONCURRENT = 3;

type Task = {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  // Checked just before the task leaves the queue. If it returns true, the
  // task is dropped without touching the network (its promise resolves
  // null) and without consuming a slot. Used to abandon artwork for tiles
  // that scrolled out of view while their fetch was still queued — the
  // All Playlists grid mounts hundreds of tiles, and without this a fast
  // scroll enqueues hundreds of un-cancellable fetches that starve the link.
  shouldSkip?: () => boolean;
};

const queue: Task[] = [];
let active = 0;

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length) {
    const t = queue.shift()!;
    if (t.shouldSkip?.()) {
      // Abandoned while queued (tile scrolled away): never hit the network,
      // don't consume a slot. Draining hundreds of these is microseconds, so
      // 'back' traffic (JSON pages, the remote poll) can't starve behind them.
      t.resolve(null);
      continue;
    }
    active++;
    t.run().then(
      v => {
        active--;
        t.resolve(v);
        pump();
      },
      e => {
        active--;
        t.reject(e);
        pump();
      },
    );
  }
}

// priority 'front': the task jumps ahead of queued work (but never preempts
// a running one). 'back': normal FIFO order.
// shouldSkip: optional abandonment check, evaluated when the task reaches the
// front of the queue. Artwork tiles pass one tied to their viewport
// visibility; JSON/commands never pass one (a skipped JSON reply resolves
// null, which would corrupt the caller — so don't).
export function gatedNet<T>(
  task: () => Promise<T>,
  priority: 'front' | 'back' = 'back',
  shouldSkip?: () => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t: Task = { run: task, resolve: resolve as (v: unknown) => void, reject, shouldSkip };
    if (priority === 'front') queue.unshift(t);
    else queue.push(t);
    pump();
  });
}

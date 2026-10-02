// Shared gate for ALL phone-tunnel traffic (net.fetch JSON, artwork, remote
// commands). The iPhone companion buffers each net.fetch reply fully before
// sending it back as a single gateway message; firing ~9 concurrent fetches
// on app load wedges the companion and stalls the Bluetooth link.
//
// Two lanes:
//   'net' — JSON and remote commands, up to 3 concurrent (small replies).
//   'art' — image downloads, STRICTLY SERIAL (1 concurrent). Art replies are
//           the large ones the phone has to fully buffer, and a fresh install
//           fires dozens of them at once (every tile misses every cache).
//           Letting 3 of those run side-by-side was still knocking the link
//           over, so artwork now drains one at a time while JSON always keeps
//           free slots — library lists load even mid-art-burst.
//
// Within a lane: FIFO, except 'front' priority jumps the queue (user taps,
// on-screen art). Lanes never block each other: a queued artwork fetch can
// never starve a JSON request, and vice versa.
const MAX_NET = 3;
const MAX_ART = 1;

export type Lane = 'net' | 'art';

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

const queues: Record<Lane, Task[]> = { net: [], art: [] };
const active: Record<Lane, number> = { net: 0, art: 0 };
const maxFor: Record<Lane, number> = { net: MAX_NET, art: MAX_ART };

// Hard client-side timeout for gated tasks. The daemon's net.fetch is
// supposed to honor timeoutMs, but if it hangs (Bluetooth stall), the gate
// slot leaks forever and all subsequent requests queue behind it. This
// guarantees the slot is freed.
const GATE_HARD_TIMEOUT_MS = 20_000;

function pumpLane(lane: Lane): void {
  const q = queues[lane];
  while (active[lane] < maxFor[lane] && q.length) {
    const t = q.shift()!;
    if (t.shouldSkip?.()) {
      // Abandoned while queued (tile scrolled away): never hit the network,
      // don't consume a slot. Draining hundreds of these is microseconds.
      t.resolve(null);
      continue;
    }
    active[lane]++;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      active[lane]--;
      t.reject(new Error('gatedNet hard timeout'));
      pumpLane(lane);
    }, GATE_HARD_TIMEOUT_MS);
    t.run().then(
      v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active[lane]--;
        t.resolve(v);
        pumpLane(lane);
      },
      e => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active[lane]--;
        t.reject(e);
        pumpLane(lane);
      },
    );
  }
}

// Remote-switch art deferral: after a remote track change, the Bluetooth
// link is busy with command + polls. New art downloads wait until the link
// stabilizes; memory-cached art still shows instantly (checked before this).
let artDeferUntil = 0;
export function deferArtLoads(ms: number): void {
  artDeferUntil = Math.max(artDeferUntil, Date.now() + ms);
}
export function artDeferWaitMs(): number {
  return Math.max(0, artDeferUntil - Date.now());
}

// priority 'front': the task jumps ahead of queued work in its lane (but
// never preempts a running one). 'back': normal FIFO order.
// shouldSkip: optional abandonment check, evaluated when the task reaches the
// front of the queue. Artwork tiles pass one tied to their viewport
// visibility; JSON/commands never pass one (a skipped JSON reply resolves
// null, which would corrupt the caller — so don't).
// lane: 'net' (default) for JSON/commands, 'art' for image downloads.
export function gatedNet<T>(
  task: () => Promise<T>,
  priority: 'front' | 'back' = 'back',
  shouldSkip?: () => boolean,
  lane: Lane = 'net',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t: Task = { run: task, resolve: resolve as (v: unknown) => void, reject, shouldSkip };
    const q = queues[lane];
    if (priority === 'front') q.unshift(t);
    else q.push(t);
    pumpLane(lane);
  });
}

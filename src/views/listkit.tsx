import { useEffect, useRef, useState } from 'react';
import { cached, stickyGet, stickySet } from '../cache';
import {
  AuthError,
  Empty,
  SkeletonGridCard,
  SkeletonTile,
  friendlyError,
  useLinkGen,
} from '../components';
import { isAuthError } from '../jellyfin';
import type { NavFn } from '../nav';

// One Bluetooth-tunneled list response must stay small: the full lists page
// through the library instead of fetching it as one giant JSON blob (a
// multi-thousand-album library in a single frame is what was knocking the
// link over). Pages render progressively and the rest fill in behind while
// the user browses.
export const LIB_PAGE = 120;
// Rails show 5 items with a See all (only when the section holds more than
// 5); the full list lives one tap away.
export const RAIL_N = 5;

// Keep-alive across unmounts: opening a playlist/album unmounts the view,
// and coming back shouldn't jump to the top or refetch everything.
const scrollTops = new Map<string, number>();
const lastFullLoad = new Map<string, number>();
const FRESH_MS = 5 * 60 * 1000;

export function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (
        <SkeletonGridCard key={i} />
      ))}
    </div>
  );
}

export function RailSkeleton() {
  return (
    <section className="mb-7" aria-hidden>
      <div className="skeleton mx-5 mb-3 h-4 w-40 rounded" />
      <div className="flex gap-4 overflow-hidden px-5 [&>*]:min-w-0 [&>*]:flex-1">
        {[0, 1, 2, 3, 4].map(i => (
          <SkeletonTile key={i} fluid />
        ))}
      </div>
    </section>
  );
}

// Restores the saved scroll position once `ready` flips true (fresh mount
// only), and keeps saving it on scroll and on unmount.
export function useScrollKeepAlive(
  key: string,
  ready: boolean,
): { ref: React.RefObject<HTMLDivElement | null>; onScroll: (e: React.UIEvent<HTMLDivElement>) => void } {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const el = ref.current;
    if (el) {
      const y = scrollTops.get(key) ?? 0;
      if (y > 0) el.scrollTop = y;
    }
  }, [key, ready]);
  useEffect(
    () => () => {
      const el = ref.current;
      if (el) scrollTops.set(key, el.scrollTop);
    },
    [key],
  );
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    scrollTops.set(key, e.currentTarget.scrollTop);
  };
  return { ref, onScroll };
}

// Small bounded fetch, sticky-seeded so rails paint instantly (Home-style).
export function useBounded<T>(key: string, load: () => Promise<T[]>) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
  const linkGen = useLinkGen();
  useEffect(() => {
    let dead = false;
    setError(null);
    setRawError(null);
    const sticky = stickyGet<T[]>(key);
    setData(sticky);
    cached(key, load).then(
      d => {
        if (dead) return;
        setData(d);
        stickySet(key, d);
      },
      e => {
        if (dead) return;
        if (sticky?.length) return;
        setError(friendlyError(e));
        setRawError(e);
      },
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryKey]);
  useEffect(() => {
    if (linkGen > 0 && error) setRetryKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkGen]);
  return { data, error, rawError, retry: () => setRetryKey(k => k + 1) };
}

// Full-list fetch, paged progressively with sticky seeding.
export function usePagedList<T>(key: string, fetchPage: (start: number, limit: number) => Promise<T[]>) {
  const [data, setData] = useState<T[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawError, setRawError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
  const linkGen = useLinkGen();
  useEffect(() => {
    setData(stickyGet<T[]>(key));
  }, [key]);
  useEffect(() => {
    let dead = false;
    setError(null);
    setRawError(null);
    setLoadingMore(false);
    const seeded = !!stickyGet<unknown[]>(key)?.length;
    if (retryKey === 0 && seeded && Date.now() - (lastFullLoad.get(key) ?? 0) < FRESH_MS) {
      return () => {
        dead = true;
      };
    }
    const run = async () => {
      const all: T[] = [];
      let start = 0;
      for (;;) {
        let page: T[];
        try {
          page = await fetchPage(start, LIB_PAGE);
        } catch (e) {
          if (!dead && all.length === 0 && !seeded) {
            setError(friendlyError(e));
            setRawError(e);
          }
          if (!dead) setLoadingMore(false);
          return;
        }
        if (dead) return;
        all.push(...page);
        setData([...all]);
        if (page.length < LIB_PAGE) break;
        setLoadingMore(true);
        start += LIB_PAGE;
      }
      if (!dead) {
        setLoadingMore(false);
        stickySet(key, all);
        lastFullLoad.set(key, Date.now());
      }
    };
    void run();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retryKey]);
  useEffect(() => {
    if (linkGen > 0 && error) setRetryKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkGen]);
  return { data, loadingMore, error, rawError, retry: () => setRetryKey(k => k + 1) };
}

export function ListError({
  error,
  rawError,
  onRetry,
  what,
  nav,
}: {
  error: string;
  rawError: unknown;
  onRetry: () => void;
  what: string;
  nav: NavFn;
}) {
  return isAuthError(rawError) ? (
    <AuthError
      text="Jellyfin rejected the saved sign-in. Reconnect with Quick Connect or an API key."
      onReconnect={() => nav({ name: 'setup' })}
    />
  ) : (
    <Empty text={`Could not load ${what}: ${error}`} onRetry={onRetry} />
  );
}

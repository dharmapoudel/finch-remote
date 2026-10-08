import { useEffect, useState } from 'react';

// Finch 1.4.1: pre-blurred backdrops. The same trick 1.3.1 used for its
// ambient glow (a tiny image scaled up is far cheaper than blurring a
// full-screen one), done once per artwork on a 36px canvas: the result is
// a static image the GPU only has to scale, so nothing re-blurs while the
// Now Playing sheet morphs, lyrics scroll or a menu slides over it.

const SIZE = 36;
const cache = new Map<string, Promise<string | null>>();
const done = new Map<string, string | null>();
const MAX = 40;

function make(src: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = SIZE;
        c.height = SIZE;
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(null);
        const canFilter = 'filter' in ctx;
        if (canFilter) ctx.filter = 'blur(2.5px) saturate(1.25)';
        // overdraw so the blur has no transparent edges
        ctx.drawImage(img, -5, -5, SIZE + 10, SIZE + 10);
        c.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.85);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function blurredUrl(src: string): Promise<string | null> {
  let p = cache.get(src);
  if (!p) {
    p = make(src).then(u => {
      done.set(src, u);
      return u;
    });
    cache.set(src, p);
    if (cache.size > MAX) {
      const old = cache.keys().next().value as string;
      const u = done.get(old);
      if (u) URL.revokeObjectURL(u);
      cache.delete(old);
      done.delete(old);
    }
  }
  return p;
}

/** A small pre-blurred copy of `src` (null until ready, or when src is null). */
export function useBlurred(src: string | null): string | null {
  const [state, setState] = useState<{ src: string; url: string | null } | null>(() =>
    src && done.has(src) ? { src, url: done.get(src) ?? null } : null,
  );
  useEffect(() => {
    if (!src) return;
    if (done.has(src)) {
      setState({ src, url: done.get(src) ?? null });
      return;
    }
    let live = true;
    void blurredUrl(src).then(url => live && setState({ src, url }));
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return null;
  return state && state.src === src ? state.url : null;
}

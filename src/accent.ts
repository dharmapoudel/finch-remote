// Artwork accent extraction, ported from o-music (Ousa-Music-Player-v1):
// the accent is pulled off the album art, so it has to survive dark covers,
// blown out covers and greyscale ones.
//
// 1.4.2: sampled the way the art is drawn on screen (an <img> on the art's
// own object URL), never by fetching the blob: URL back (fetch() is subject
// to the webview's connect-src and fails where <img> works). Failures are
// not cached forever, a blank read-back counts as a failure, greyscale
// covers get a neutral accent (gold only when there is no art), the fill is
// lifted until it reads on the dark panel, and results are remembered per
// artwork key across restarts (localStorage, 300 entries).

import { useEffect, useState } from 'react';

const SAMPLE_PX = 32;
const HUE_BUCKETS = 12;

export type Accent = {
  fill: string;
  fill2: string;
  ink: string;
  soft: string;
  soft2: string;
};

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return { h, s, l };
}

// srgb relative luminance, to decide whether a glyph sits dark or light on the fill
function luminance(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h * 6) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg].map(v => {
    const u = v + m;
    return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Accent from 32x32 RGBA pixels. null = nothing sampled (blank read-back). */
export function accentFromPixels(data: Uint8ClampedArray): Accent | null {
  let opaque = 0;
  let hx = 0;
  let hy = 0;
  let lSum = 0;
  const weight = new Float64Array(HUE_BUCKETS);
  const satSum = new Float64Array(HUE_BUCKETS);
  // circular mean per bucket, so a red that straddles both ends of the wheel averages back to red
  const cosSum = new Float64Array(HUE_BUCKETS);
  const sinSum = new Float64Array(HUE_BUCKETS);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    opaque++;
    const { h, s, l } = toHsl(data[i], data[i + 1], data[i + 2]);
    lSum += l;
    hx += Math.cos(h * 2 * Math.PI) * s;
    hy += Math.sin(h * 2 * Math.PI) * s;
    // greys, crushed blacks and blown highlights carry no usable hue
    if (s < 0.18 || l < 0.12 || l > 0.92) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    weight[bucket] += w;
    satSum[bucket] += s * w;
    cosSum[bucket] += Math.cos(h * 2 * Math.PI) * w;
    sinSum[bucket] += Math.sin(h * 2 * Math.PI) * w;
  }

  let best = -1;
  let bestWeight = 0;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (weight[i] > bestWeight) {
      bestWeight = weight[i];
      best = i;
    }
  }
  // An all-transparent read-back (blank canvas) is a failed sample.
  if (opaque === 0) return null;
  if (best < 0) {
    // greyscale / near-black / blown-out cover: a neutral accent with the
    // faintest cast of the cover's own hue (gold is only for "no art")
    let gh = Math.atan2(hy, hx) / (2 * Math.PI);
    if (gh < 0) gh += 1;
    const gl = Math.round(Math.min(84, Math.max(74, (lSum / opaque) * 100 + 30)));
    return {
      fill: `hsl(${Math.round(gh * 360)} 10% ${gl}%)`,
      fill2: `hsl(${Math.round(gh * 360)} 8% ${gl - 8}%)`,
      ink: '#060809',
      soft: `hsl(${Math.round(gh * 360)} 8% 86%)`,
      soft2: `hsl(${Math.round(gh * 360)} 6% 80%)`,
    };
  }

  // the runner-up hue gives the gradient a second colour that is genuinely off the cover
  let runnerUp = -1;
  let runnerWeight = 0;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (i !== best && weight[i] > runnerWeight) {
      runnerWeight = weight[i];
      runnerUp = i;
    }
  }

  const hueOf = (bucket: number): number => {
    let h = Math.atan2(sinSum[bucket], cosSum[bucket]) / (2 * Math.PI);
    if (h < 0) h += 1;
    return h;
  };
  // the cover's own saturation would read muddy at this size, so it is pushed up and floored
  const satOf = (bucket: number): number =>
    Math.min(0.92, Math.max(0.55, (satSum[bucket] / weight[bucket]) * 1.25));

  const h = hueOf(best);
  const s = satOf(best);
  // a cover with one hue would otherwise gradient from a colour to itself, so it is shifted instead
  const paired = runnerUp >= 0 && runnerWeight > bestWeight * 0.12;
  const h2 = paired ? hueOf(runnerUp) : (h + 0.075) % 1;
  const s2 = paired ? satOf(runnerUp) : s;

  const css = (hue: number, sat: number, light: number): string =>
    `hsl(${Math.round(hue * 360)} ${Math.round(sat * 100)}% ${light}%)`;

  // Legibility on the dark panel (#0b0d10, L~0.004): lift the lightness until
  // the fill has at least 5:1 contrast (deep blues/violets need it).
  const lift = (hue: number, sat: number): number => {
    let l = 0.62;
    while (l < 0.8 && (luminance(hue, sat, l) + 0.05) / (0.0045 + 0.05) < 5) l += 0.02;
    return l;
  };
  const l1 = lift(h, s);
  const l2 = lift(h2, s2);
  const pct = (v: number) => Math.round(v * 100);
  return {
    fill: css(h, s, pct(l1)),
    fill2: css(h2, s2, pct(l2)),
    ink: luminance(h, s, l1) > 0.42 ? '#060809' : '#f4f6f8',
    soft: css(h, Math.min(s, 0.6), 74),
    soft2: css(h2, Math.min(s2, 0.6), 74),
  };
}

// ---- sampling + caches ----

const SAMPLE_TIMEOUT = 8000;

/** Decode the art URL the way the screen does (<img>) and sample it at 32px. */
function sampleUrl(url: string): Promise<Accent | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const finish = (a: Accent | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(a);
    };
    const timer = window.setTimeout(() => finish(null), SAMPLE_TIMEOUT);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE_PX;
        canvas.height = SAMPLE_PX;
        // willReadFrequently keeps this canvas in CPU memory, so the
        // read-back never depends on the GPU.
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX);
        finish(accentFromPixels(ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

// Memory: keyed by art key when known (stable across sessions), else URL.
const mem = new Map<string, Accent>();
const MEM_MAX = 300;
const inflight = new Map<string, Promise<Accent | null>>();
const LS_KEY = 'finch:accents:v1';
let disk: Record<string, Accent> | null = null;
let diskTimer: number | null = null;

function loadDisk(): Record<string, Accent> {
  if (disk) return disk;
  try {
    disk = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, Accent>;
  } catch {
    disk = {};
  }
  return disk;
}
function saveDisk(key: string, a: Accent): void {
  const d = loadDisk();
  delete d[key];
  d[key] = a;
  const keys = Object.keys(d);
  for (let i = 0; i < keys.length - MEM_MAX; i++) delete d[keys[i]];
  if (diskTimer !== null) return;
  diskTimer = window.setTimeout(() => {
    diskTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(disk));
    } catch {
      /* storage full or unavailable: memory only */
    }
  }, 1500);
}
function remember(id: string, a: Accent, persist: boolean): void {
  mem.delete(id);
  mem.set(id, a);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
  if (persist) saveDisk(id, a);
}

/** Known accent for an id (art key or URL), without sampling. */
export function peekAccent(id: string | null | undefined): Accent | undefined {
  if (!id) return undefined;
  const hit = mem.get(id);
  if (hit) return hit;
  if (!id.startsWith('blob:') && !id.startsWith('data:')) {
    const d = loadDisk()[id];
    if (d) {
      mem.set(id, d);
      return d;
    }
  }
  return undefined;
}

/**
 * Accent for an artwork URL, sampled once per id (art key when given, else
 * the URL). A failed sample is retried once and never cached, so a later
 * call can still succeed.
 */
export function accentFor(url: string, key?: string | null): Promise<Accent | null> {
  const id = key ?? url;
  const hit = peekAccent(id);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    p = sampleUrl(url)
      .then(a => a ?? new Promise<Accent | null>(r => window.setTimeout(() => void sampleUrl(url).then(r), 600)))
      .then(a => {
        inflight.delete(id);
        if (a) remember(id, a, !!key);
        return a;
      });
    inflight.set(id, p);
  }
  return p;
}

/**
 * Accent for the art shown now. While the next track's art is still loading
 * (url null, key known) the previous accent stays, so colours crossfade from
 * cover to cover instead of flashing gold; null only when there is no art.
 */
export function useAccent(artUrl: string | null, key?: string | null, hasArt = !!artUrl): Accent | null {
  const id = key ?? artUrl;
  const [accent, setAccent] = useState<Accent | null>(() => peekAccent(id) ?? null);
  useEffect(() => {
    if (!hasArt) {
      setAccent(null);
      return;
    }
    const hit = peekAccent(id);
    if (hit) {
      setAccent(hit);
      return;
    }
    if (!artUrl) return; // art still loading: keep the previous accent
    let live = true;
    void accentFor(artUrl, key).then(a => {
      if (live && a) setAccent(a);
      else if (live && !a) setAccent(null);
    });
    return () => {
      live = false;
    };
  }, [artUrl, id, key, hasArt]);
  return accent;
}

/** Non-hook variant (browse backdrops), sharing the caches. */
export function accentFromUrl(artUrl: string, key?: string | null): Promise<Accent | null> {
  return accentFor(artUrl, key);
}

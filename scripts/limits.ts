// Bundle size limits the device enforces at install time (see
// node_modules/@bridgething/lib/dist/bindings/shared.d.ts, WebappManifest):
//   icon      over 64 KiB  -> silently dropped, the app installs without an icon
//   settings  over 1 MiB   -> the whole install fails
//   overlay   over 512 KiB -> the whole install fails
// checkBundle() is run by the Vite builds (bundleLimits plugin) and by the
// share script, so an over-limit bundle can never be built or zipped.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export const LIMITS = {
  icon: 64 * 1024,
  settings: 1024 * 1024,
  overlay: 512 * 1024,
} as const;

type Field = keyof typeof LIMITS;

const kib = (n: number): string => `${(n / 1024).toFixed(1)} KiB`;

/** Problems with the built bundle in distDir; empty when it is fine. */
export function checkBundle(distDir: string, publicDir?: string): string[] {
  const errors: string[] = [];
  const manifestPath = join(distDir, 'manifest.json');
  if (!existsSync(manifestPath)) return errors; // nothing built yet
  let manifest: Partial<Record<Field, string | null>>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Record<Field, string | null>>;
  } catch (e) {
    return [`dist/manifest.json is not valid JSON: ${String(e)}`];
  }
  for (const field of Object.keys(LIMITS) as Field[]) {
    const rel = manifest[field];
    if (!rel) continue;
    const file = join(distDir, rel);
    if (!existsSync(file)) {
      // settings.html is written by the second build; only the last build
      // in the chain sees every file.
      continue;
    }
    const size = statSync(file).size;
    if (size > LIMITS[field]) {
      errors.push(
        `${field} "${rel}" is ${size} bytes (${kib(size)}), over the device limit of ${LIMITS[field]} bytes (${kib(LIMITS[field])})`,
      );
    }
  }
  // The icon is copied from public/ verbatim; a build step that touched it
  // (re-encoding, inlining) would change what was size-checked.
  if (publicDir && manifest.icon) {
    const src = join(publicDir, manifest.icon);
    const out = join(distDir, manifest.icon);
    if (existsSync(src) && existsSync(out) && !readFileSync(src).equals(readFileSync(out))) {
      errors.push(`dist/${manifest.icon} differs from public/${manifest.icon}: the build must copy the icon unchanged`);
    }
  }
  return errors;
}

/** Vite plugin: fail the build when the bundle breaks a device limit. */
export function bundleLimits(root: string): Plugin {
  return {
    name: 'bridgething-bundle-limits',
    apply: 'build',
    closeBundle() {
      const errors = checkBundle(resolve(root, 'dist'), resolve(root, 'public'));
      if (errors.length) {
        throw new Error(`bundle over device limits:\n  - ${errors.join('\n  - ')}`);
      }
    },
  };
}

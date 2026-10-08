#!/usr/bin/env node
// Packs dist/ into <name>-<version>.zip, the file the BridgeThing companion app installs.
import { zipSync } from 'fflate';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle } from './limits.ts';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoDir, 'dist');
const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`no manifest.json at ${manifestPath}; run 'npm run build' first`);
  process.exit(1);
}
// Same device-limit check the builds run (icon <= 64 KiB, settings <= 1 MiB,
// overlay <= 512 KiB): an over-limit bundle is never zipped.
const limitErrors = checkBundle(distDir, resolve(repoDir, 'public'));
if (limitErrors.length) {
  console.error(`bundle over device limits:\n  - ${limitErrors.join('\n  - ')}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const name = (manifest.name || 'webapp').replace(/[^a-z0-9._-]+/gi, '-');
const version = manifest.version || '0.0.0';

const files = {};
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs);
    else if (!abs.endsWith('.map')) files[relative(distDir, abs).split('\\').join('/')] = new Uint8Array(readFileSync(abs));
  }
};
walk(distDir);

const out = resolve(repoDir, `${name}-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`wrote ${relative(process.cwd(), out)} (${Object.keys(files).length} files)`);

#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(process.argv[2] ?? resolve(repoRoot, 'ui/dist'));
const overrides = resolve(repoRoot, 'ui/overrides');
const indexPath = resolve(dist, 'index.html');
const manifestPath = resolve(dist, 'manifest.webmanifest');

for (const name of ['favicon.png', 'app-icon-512.png']) {
  const source = resolve(overrides, name);
  if (!existsSync(source)) throw new Error(`Missing generated brand asset: ${source}`);
  copyFileSync(source, resolve(dist, name));
}

const index = readFileSync(indexPath, 'utf8');
const iconLink = /<link\b(?=[^>]*\brel=["']icon["'])[^>]*\/?\s*>/i;
if (!iconLink.test(index)) throw new Error(`No favicon link in ${indexPath}`);
writeFileSync(indexPath, index.replace(iconLink, '<link rel="icon" type="image/png" href="/favicon.png" />'));

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.icons = [
  { src: '/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// The old SVG is no longer referenced by the packaged shell or manifest.
rmSync(resolve(dist, 'favicon.svg'), { force: true });

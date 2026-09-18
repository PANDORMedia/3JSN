import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts/dom-canvas');
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['experiments/dom-canvas/app.mjs'],
  outfile: resolve(output, 'app.mjs'), bundle: true, format: 'esm', platform: 'browser', sourcemap: 'inline' });

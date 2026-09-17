import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts/native-html-interop');
await mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['experiments/native-html-interop/app.mjs'],
  outfile: resolve(output, 'app.mjs'), bundle: true, format: 'esm', platform: 'browser', sourcemap: 'inline' });
console.log(`Bundled unchanged shared Three.js scene to ${output}/app.mjs`);

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { prepareFonts } from '../dom-canvas/prepare-fonts.mjs';

assert.equal(process.argv.length, 2, 'Usage: node experiments/web-font-matcher/check-upstream.mjs');
const root = resolve(import.meta.dirname, '../..');
const cargoHome = resolve(process.env.CARGO_HOME || resolve(homedir(), '.cargo'));
await prepareFonts(root, cargoHome, true);
const directory = resolve(root, '.cache/web-fonts/baseline-check');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'Cargo.toml'), `[package]
name = "web-font-baseline-check"
version = "0.0.0"
edition = "2024"
[workspace]
[dependencies]
fontique = { version = "=0.11.1", default-features = false, features = ["std"] }
[[test]]
name = "upstream_regressions"
path = ${JSON.stringify(resolve(import.meta.dirname, 'tests/upstream_regressions.rs'))}
`);
const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', resolve(directory, 'Cargo.toml')], {
  cwd: root,
  env: { ...process.env, CARGO_HOME: cargoHome, CARGO_BUILD_JOBS: '2', CARGO_TARGET_DIR: resolve(root, '.cache/web-fonts/target') },
  encoding: 'utf8', timeout: 120_000,
});
const output = `${result.stdout || ''}${result.stderr || ''}`;
await writeFile(resolve(root, '.cache/web-fonts/baseline-tests.txt'), output);
assert.equal(result.status, 101, result.error?.message || output);
assert.match(output, /test result: FAILED\. 0 passed; 2 failed;/);
for (const name of ['duplicate_coverage_variants_are_all_queried', 'scalar_weight_override_still_sets_nondefault_variable_coordinate']) {
  assert.match(output, new RegExp(`test ${name} \\.{3} FAILED`));
}
console.log(JSON.stringify({ baseline: 'fontique 0.11.1', expectedFailures: 2, log: '.cache/web-fonts/baseline-tests.txt' }, null, 2));

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { featureStatus, readProfile, validateProfile } from './profile.mjs';

const path = resolve(import.meta.dirname, '../../docs/profiles/experimental-desktop-v1.json');

test('initial profile makes no unsupported certification and evidence paths exist', async () => {
  const profile = await readProfile(path);
  assert(profile.targets.every((target) => target.status === 'unverified'));
  assert(profile.features.every((feature) => feature.status !== 'supported'));
  for (const feature of profile.features) for (const evidence of feature.evidence) await access(resolve(dirname(path), evidence.path));
  assert.equal(featureStatus(profile, 'services.webrtc', 'macos-arm64').status, 'unsupported');
  assert.equal(featureStatus(profile, 'runtime.wasm', 'macos-arm64').status, 'unknown');
  assert.equal(featureStatus(profile, 'undeclared.dynamic-api', 'macos-arm64').status, 'unknown');
  assert.equal(featureStatus(profile, 'graphics.webgpu', 'imaginary-target').status, 'unknown');
});

test('probe and browser reference cannot promote a native support claim', async () => {
  const profile = await readProfile(path);
  profile.features[0].status = 'supported';
  assert.throws(() => validateProfile(profile), { code: 'INVALID_PROFILE' });
  profile.features[0].evidence = [{ kind: 'browser-reference', path: 'reference.json' }];
  assert.throws(() => validateProfile(profile), { code: 'INVALID_PROFILE' });
  profile.features[0].evidence = [{ kind: 'native-integration', target: 'macos-arm64', path: 'native.json', runtime: 'test-only', versions: 'pinned test dependencies', constraints: 'fixture only', date: '2026-09-17' }];
  assert.equal(featureStatus(profile, 'graphics.webgpu', 'macos-arm64').status, 'supported');
  assert.equal(featureStatus(profile, 'graphics.webgpu', 'windows-x64').status, 'unknown');
});

test('malformed and duplicate declarations fail validation', async () => {
  const profile = await readProfile(path);
  for (const mutate of [
    (value) => { value.sourcePolicy.applicationEdits = 'allowed'; },
    (value) => { value.targets.push(value.targets[0]); },
    (value) => { value.features.push(value.features[0]); },
    (value) => { value.features[0].status = 'probably'; },
    (value) => { value.targets[0].status = 'verified'; },
    (value) => { value.features[0].evidence = [null]; },
  ]) {
    const copy = structuredClone(profile);
    mutate(copy);
    assert.throws(() => validateProfile(copy), { code: 'INVALID_PROFILE' });
  }
});

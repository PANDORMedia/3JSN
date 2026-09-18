import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BuildError, COMPILED_DOM_PROFILE } from './contract.mjs';

export const ANGLE_CAPABILITY = 'native-webgl-angle-metal-v1';
export const ANGLE_DESCRIPTOR = Object.freeze({ backend: 'angle-metal', abiVersion: 1, directory: 'app/native/angle' });
const specs = [
  { source: 'package.json', limit: 1024 * 1024 },
  { source: 'deps/darwin/dylib/libEGL.dylib', name: 'libEGL.dylib', limit: 64 * 1024 * 1024 },
  { source: 'deps/darwin/dylib/libGLESv2.dylib', name: 'libGLESv2.dylib', limit: 64 * 1024 * 1024 },
  { source: 'LICENSES', name: 'LICENSES', limit: 4 * 1024 * 1024 },
];
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const same = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;
const cancelled = signal => {
  if (signal?.aborted) throw new BuildError('CANCELLED', 'Build cancelled while packaging ANGLE.');
};

export function validateAngleOptions(value, profile, target) {
  if (typeof value !== 'string' || !value) throw new BuildError('USAGE', '--angle-package requires a package directory.');
  if (profile !== COMPILED_DOM_PROFILE) throw new BuildError('UNEXPECTED_ANGLE_PACKAGE', '--angle-package is accepted only by compiled-dom-window-v1.');
  if (!['macos-arm64', 'macos-x64'].includes(target)) throw new BuildError('UNSUPPORTED_TARGET', 'ANGLE packaging currently requires a current-host macOS target.');
}

export function validateAngleRuntime(description) {
  if (!Array.isArray(description.capabilities) || !description.capabilities.includes(ANGLE_CAPABILITY)) {
    throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied player must advertise ${ANGLE_CAPABILITY}.`);
  }
}

async function measuredRead(root, spec) {
  if (!(await lstat(root)).isDirectory()) throw new BuildError('INVALID_ANGLE_PACKAGE', 'ANGLE input root must remain a real directory.');
  let path = root;
  const parts = spec.source.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path);
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || !(last ? stat.isFile() : stat.isDirectory())) {
      throw new BuildError('INVALID_ANGLE_PACKAGE', 'ANGLE inputs must be regular files without package-relative symbolic links.');
    }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n || before.size > BigInt(spec.limit)) throw new BuildError('INVALID_ANGLE_PACKAGE', `ANGLE ${spec.source} exceeds its nonzero size limit.`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new BuildError('ANGLE_CHANGED', 'ANGLE input was truncated during inspection.');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if ([after, current].some(stat => !stat.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== stat[key]))) {
      throw new BuildError('ANGLE_CHANGED', 'ANGLE input changed during inspection.');
    }
    return { bytes, identity: identity(bytes) };
  } finally { await handle.close(); }
}

export async function inspectAnglePackage(value, signal) {
  const supplied = resolve(value);
  if (!(await lstat(supplied)).isDirectory()) throw new BuildError('INVALID_ANGLE_PACKAGE', 'ANGLE package must be a real directory.');
  const root = await realpath(supplied);
  const inputs = [];
  for (const spec of specs) {
    cancelled(signal);
    const read = await measuredRead(root, spec);
    inputs.push({ ...spec, before: read.identity });
    if (spec.source === 'package.json') {
      let metadata;
      try { metadata = JSON.parse(read.bytes); } catch (cause) { throw new BuildError('INVALID_ANGLE_PACKAGE', 'ANGLE package.json must be valid JSON.', { cause }); }
      if (metadata?.name !== 'gl' || metadata?.version !== '9.0.0-rc.10') throw new BuildError('INVALID_ANGLE_PACKAGE', 'Expected an explicitly supplied gl@9.0.0-rc.10 package.');
    }
  }
  return { root, inputs };
}

export async function copyAnglePackage(angle, staging, signal) {
  await mkdir(join(staging, ANGLE_DESCRIPTOR.directory), { recursive: true });
  const files = [];
  for (const input of angle.inputs.filter(input => input.name)) {
    cancelled(signal);
    const read = await measuredRead(angle.root, input);
    if (!same(read.identity, input.before)) throw new BuildError('ANGLE_CHANGED', 'ANGLE input changed before copying.');
    const path = `${ANGLE_DESCRIPTOR.directory}/${input.name}`;
    await writeFile(join(staging, path), read.bytes, { flag: 'wx' });
    input.copied = (await measuredRead(staging, { source: path, limit: input.limit })).identity;
    if (!same(input.copied, input.before)) throw new BuildError('ANGLE_CHANGED', 'Copied ANGLE bytes differ from the inspected input.');
    files.push({ path, ...input.copied });
  }
  return files;
}

export async function verifyAnglePackage(angle) {
  let failure;
  for (const input of angle.inputs) {
    input.after = undefined; input.preserved = null;
    try {
      input.after = (await measuredRead(angle.root, input)).identity;
      input.preserved = same(input.before, input.after);
      if (!input.preserved) throw new BuildError('ANGLE_CHANGED', 'ANGLE source changed during the build.');
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export const angleMetadata = angle => ({
  package: { name: 'gl', version: '9.0.0-rc.10' }, capability: ANGLE_CAPABILITY,
  scope: 'Explicit trusted local package; metadata is not authenticated provenance or a complete native dependency/license inventory. Mach-O architecture, loading, signing and hardware require separate validation.',
  inputs: angle.inputs.map(input => ({ source: input.source,
    ...(input.name ? { packagedPath: `${ANGLE_DESCRIPTOR.directory}/${input.name}` } : {}),
    before: input.before, copied: input.copied ?? null, after: input.after ?? null, preserved: input.preserved ?? null })),
});

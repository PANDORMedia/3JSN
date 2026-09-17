import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compareSnapshots, readSnapshot, snapshotTree, SnapshotError } from './snapshot.mjs';

const usage = 'snapshot-cli.mjs capture <root> <manifest.json> [--exclude <relative-path>]... | verify <root> <manifest.json>';
const [command, input, output, ...options] = process.argv.slice(2);
async function canonicalDestination(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
try {
  if (!['capture', 'verify'].includes(command) || !input || !output) throw new SnapshotError('USAGE', usage);
  const exclude = [];
  for (let i = 0; i < options.length; i += 2) {
    if (command !== 'capture' || options[i] !== '--exclude' || !options[i + 1]) throw new SnapshotError('USAGE', usage);
    exclude.push(options[i + 1]);
  }
  const root = resolve(input);
  const manifestPath = resolve(output);
  const rel = relative(await realpath(root), await canonicalDestination(manifestPath));
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
    throw new SnapshotError('INVALID_OUTPUT', 'Keep snapshot manifests outside the source root to avoid modifying the input being measured.');
  }
  if (command === 'capture') {
    const manifest = await snapshotTree(root, { exclude });
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ captured: true, entries: manifest.entries.length, digest: manifest.digest }));
  } else {
    const before = await readSnapshot(manifestPath);
    const after = await snapshotTree(root, { exclude: before.exclusions });
    const result = compareSnapshots(before, after);
    console.log(JSON.stringify(result));
    if (!result.preserved) process.exitCode = 4;
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'IO_ERROR', message: error.message } }));
  process.exitCode = error instanceof SnapshotError && ['USAGE', 'INVALID_PATH', 'INVALID_OUTPUT', 'INVALID_EXCLUSIONS', 'INVALID_MANIFEST', 'INVALID_ROOT'].includes(error.code) ? 2 : 3;
}

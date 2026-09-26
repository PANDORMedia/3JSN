import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildError, portablePath } from './contract.mjs';

export const WEB_FONT_LIMITS = Object.freeze({ resources: 64, importDepth: 8, redirects: 5,
  stylesheetBytes: 1024 * 1024, fontBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, timeoutMs: 15_000 });
export const WEB_FONT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 3JSN-font-bundler/1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const headersFor = kind => ({ 'user-agent': WEB_FONT_USER_AGENT, accept: kind === 'stylesheet' ? 'text/css' : '*/*', 'accept-encoding': 'identity', 'accept-language': '*' });
const within = (root, path) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const fail = (code, message) => { throw new BuildError(code, message); };
function validateLimits(value) {
  const fields = Object.keys(WEB_FONT_LIMITS);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
    || fields.some(field => !Number.isSafeInteger(value[field]) || value[field] <= 0 || value[field] > WEB_FONT_LIMITS[field])) {
    fail('FONT_LIMITS_INVALID', 'Web-font limits must contain every production limit as a positive safe integer no greater than its production maximum.');
  }
  return Object.freeze({ ...value });
}
const checkAbort = signal => { if (signal?.aborted) fail('CANCELLED', 'Web-font localization was cancelled.'); };
const regular = async path => { const stat = await lstat(path); if (!stat.isFile()) fail('FONT_CACHE_INVALID', 'Expected a regular resource/cache file without a symbolic link.'); return stat; };
const remoteUrl = value => {
  let url;
  try { url = new URL(value); } catch { fail('FONT_URL_INVALID', 'Invalid web-font resource URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('FONT_URL_INVALID', 'Remote CSS/font URLs must be HTTP(S), without credentials or fragments.');
  return url.href;
};

async function futureRealpath(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await futureRealpath(parent), relative(parent, path));
  }
}

function validateLock(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries) || Object.keys(value).sort().join(',') !== 'entries,schemaVersion') fail('FONT_LOCK_INVALID', 'Invalid web-font lock schema.');
  const keys = new Set();
  for (const entry of value.entries) {
    if (!entry || !['font', 'stylesheet'].includes(entry.kind) || typeof entry.requestUrl !== 'string'
      || typeof entry.finalUrl !== 'string' || !Array.isArray(entry.redirects)
      || !entry.response || typeof entry.response.contentType !== 'string'
      || !Number.isSafeInteger(entry.response.bytes) || entry.response.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.response.sha256)
      || JSON.stringify(entry.requestHeaders) !== JSON.stringify(headersFor(entry.kind))) fail('FONT_LOCK_INVALID', 'Malformed web-font lock entry.');
    remoteUrl(entry.requestUrl); remoteUrl(entry.finalUrl);
    let expected = entry.requestUrl;
    for (const hop of entry.redirects) {
      if (!hop || hop.url !== expected || ![301, 302, 303, 307, 308].includes(hop.status) || typeof hop.location !== 'string') fail('FONT_LOCK_INVALID', 'Malformed redirect provenance.');
      expected = remoteUrl(new URL(hop.location, hop.url).href);
    }
    if (expected !== entry.finalUrl) fail('FONT_LOCK_INVALID', 'Redirect provenance does not reach the pinned final URL.');
    const key = `${entry.kind}:${entry.requestUrl}`;
    if (keys.has(key)) fail('FONT_LOCK_INVALID', 'Duplicate web-font lock entry.');
    keys.add(key);
  }
  return value;
}

/** A single build owns the lease and awaits reads sequentially. Pins never update implicitly. */
export async function openWebFontCache({ projectRoot, outputDir, stateDir, offline = false, signal, limits = WEB_FONT_LIMITS,
  protectedRoots = [], fetchImpl = globalThis.fetch }) {
  limits = validateLimits(limits);
  if (!Array.isArray(protectedRoots) || protectedRoots.some(path => typeof path !== 'string' || !path)) {
    fail('FONT_STATE_INVALID', 'Protected source roots must be existing directory paths.');
  }
  const root = await realpath(projectRoot);
  const requestedState = resolve(stateDir);
  const state = await futureRealpath(requestedState);
  const output = await futureRealpath(resolve(outputDir));
  const protectedPaths = await Promise.all(protectedRoots.map(path => realpath(path)));
  if (within(root, state) || within(state, root) || within(output, state) || within(state, output)
    || protectedPaths.some(path => within(path, state) || within(state, path))) {
    fail('FONT_STATE_INVALID', 'Web-font state must be disjoint from the project, protected source roots and package output.');
  }
  try { if ((await lstat(requestedState)).isSymbolicLink()) fail('FONT_STATE_INVALID', 'Web-font state cannot be a symbolic link.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  checkAbort(signal);
  await mkdir(state, { recursive: true });
  const lease = join(state, '.lease');
  try { await mkdir(lease); } catch (cause) { throw new BuildError('FONT_CACHE_BUSY', 'Web-font state is already leased; use a separate state directory or remove a stale lease after its owner stops.', { cause }); }
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await rm(join(lease, 'lock.json'), { force: true }); await rmdir(lease); } };
  try {
    const lockPath = join(state, 'lock.json');
    let lock = { schemaVersion: 1, entries: [] };
    try {
      const stat = await regular(lockPath);
      if (stat.size > 1024 * 1024) fail('FONT_LOCK_INVALID', 'Web-font lock exceeds 1 MiB.');
      lock = validateLock(JSON.parse(await readFile(lockPath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error instanceof BuildError ? error : new BuildError('FONT_LOCK_INVALID', 'Cannot parse web-font lock.', { cause: error });
    }
    const entries = new Map(lock.entries.map(entry => [`${entry.kind}:${entry.requestUrl}`, entry]));
    const used = new Map(), loaded = new Map(), sourceInputs = new Map();
    let totalBytes = 0, resourceCount = 0;
    const blobs = join(state, 'blobs');
    await mkdir(blobs, { recursive: true });
    if (!(await lstat(blobs)).isDirectory()) fail('FONT_CACHE_INVALID', 'Cache blobs must be a real directory.');
    const limitFor = kind => kind === 'stylesheet' ? limits.stylesheetBytes : limits.fontBytes;
    const reserve = (kind, bytes) => {
      if (bytes > limitFor(kind) || totalBytes + bytes > limits.totalBytes) fail('FONT_RESOURCE_LIMIT', 'CSS/font bytes exceed the configured localization limit.');
    };
    const readBounded = async (stream, kind, readSignal) => {
      let bytes = 0; const chunks = [];
      for await (const chunk of stream) {
        checkAbort(signal);
        if (readSignal?.aborted) fail('FONT_FETCH_TIMEOUT', 'CSS/font request exceeded its time limit.');
        bytes += chunk.length; reserve(kind, bytes); chunks.push(chunk);
      }
      reserve(kind, bytes);
      return Buffer.concat(chunks, bytes);
    };
    async function readLocal(url, kind) {
      if (url.host || url.search || url.hash) fail('FONT_URL_INVALID', 'Local CSS/font URLs cannot have a host, query or fragment.');
      let path;
      try { path = fileURLToPath(url); } catch (cause) { throw new BuildError('FONT_URL_INVALID', 'Invalid local CSS/font URL.', { cause }); }
      const rel = relative(root, path).split(sep).join('/');
      if (!within(root, path) || !portablePath(rel)) fail('FONT_SOURCE_ESCAPE', 'Local CSS/font resource leaves the project.');
      let current = root;
      for (const component of rel.split('/')) {
        current = join(current, component);
        if ((await lstat(current)).isSymbolicLink()) fail('FONT_SOURCE_ESCAPE', 'Local CSS/font resources cannot traverse symbolic links.');
      }
      const before = await regular(path); reserve(kind, before.size);
      const bytes = await readBounded(createReadStream(path), kind);
      const after = await regular(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('FONT_SOURCE_CHANGED', 'A local CSS/font input changed while reading.');
      const identity = { path: rel, bytes: bytes.length, sha256: hash(bytes) };
      sourceInputs.set(rel, identity);
      return { bytes, finalUrl: url.href, provenance: { kind, local: identity } };
    }
    async function readRemote(requestUrl, kind) {
      const key = `${kind}:${requestUrl}`;
      let pin = entries.get(key);
      let bytes;
      if (pin) {
        if (pin.redirects.length > limits.redirects) fail('FONT_RESOURCE_LIMIT', 'Pinned redirect chain exceeds the configured limit.');
        const path = join(blobs, pin.response.sha256);
        try { const stat = await regular(path); reserve(kind, stat.size); bytes = await readBounded(createReadStream(path), kind); } catch (cause) {
          if (cause.code === 'ENOENT') throw new BuildError('FONT_CACHE_MISSING', 'A pinned font/CSS cache blob is missing; pins are never silently replaced.', { cause });
          throw cause;
        }
        if (bytes.length !== pin.response.bytes || hash(bytes) !== pin.response.sha256) fail('FONT_CACHE_CORRUPT', 'A pinned CSS/font cache blob failed its content identity.');
      } else {
        if (offline) fail('FONT_OFFLINE_MISS', 'Offline mode requires a pinned cache entry for every remote CSS/font resource.');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let url = requestUrl; const redirects = [];
        try {
          for (;;) {
            checkAbort(signal);
            const response = await fetchImpl(url, { headers: headersFor(kind), redirect: 'manual', credentials: 'omit', signal: combined });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get('location'); await response.body?.cancel();
              if (!location) fail('FONT_FETCH_FAILED', 'CSS/font redirect lacks a Location header.');
              if (redirects.length >= limits.redirects) fail('FONT_RESOURCE_LIMIT', 'CSS/font redirect limit exceeded.');
              redirects.push({ url, status: response.status, location });
              url = remoteUrl(new URL(location, url).href); continue;
            }
            if (!response.ok || !response.body) { await response.body?.cancel(); fail('FONT_FETCH_FAILED', `CSS/font HTTP request failed with status ${response.status}.`); }
            const contentType = response.headers.get('content-type') ?? '';
            if (kind === 'stylesheet' && !/^text\/css(?:\s*;|\s*$)/i.test(contentType)) { await response.body.cancel(); fail('FONT_CSS_TYPE', 'Remote stylesheets must have Content-Type text/css.'); }
            bytes = await readBounded(response.body, kind, combined);
            pin = { kind, requestUrl, requestHeaders: headersFor(kind), finalUrl: url, redirects,
              response: { contentType, bytes: bytes.length, sha256: hash(bytes) } };
            break;
          }
        } catch (cause) {
          checkAbort(signal);
          if (controller.signal.aborted) throw new BuildError('FONT_FETCH_TIMEOUT', 'CSS/font request exceeded its time limit.', { cause });
          throw cause instanceof BuildError ? cause : new BuildError('FONT_FETCH_FAILED', 'CSS/font request failed.', { cause });
        } finally { clearTimeout(timeout); }
        const blob = join(blobs, pin.response.sha256);
        try { await writeFile(blob, bytes, { flag: 'wx', mode: 0o600 }); } catch (cause) {
          if (cause.code !== 'EEXIST') throw cause;
          const stat = await regular(blob);
          if (stat.size !== bytes.length) fail('FONT_CACHE_CORRUPT', 'Existing immutable font/CSS blob has a different size from downloaded content.');
          const existing = await readBounded(createReadStream(blob), kind);
          if (existing.length !== bytes.length || hash(existing) !== pin.response.sha256) fail('FONT_CACHE_CORRUPT', 'Existing immutable font/CSS blob differs from downloaded content.');
        }
        entries.set(key, pin);
      }
      used.set(key, pin);
      return { bytes, finalUrl: pin.finalUrl, provenance: pin };
    }
    return {
      stateDir: state, limits, sourceInputs,
      async read(value, kind) {
        if (closed) fail('FONT_CACHE_CLOSED', 'Web-font cache lease is closed.');
        if (!['font', 'stylesheet'].includes(kind)) fail('FONT_RESOURCE_INVALID', 'Unknown resource kind.');
        checkAbort(signal);
        const url = new URL(value);
        if (url.protocol !== 'file:') remoteUrl(url.href);
        const key = `${kind}:${url.href}`;
        if (loaded.has(key)) return loaded.get(key);
        if (++resourceCount > limits.resources) fail('FONT_RESOURCE_LIMIT', 'CSS/font resource count exceeds the configured limit.');
        const result = url.protocol === 'file:' ? await readLocal(url, kind) : await readRemote(url.href, kind);
        totalBytes += result.bytes.length;
        loaded.set(key, result);
        return result;
      },
      usedLock: () => ({ schemaVersion: 1, entries: [...used.values()].sort((a, b) => `${a.kind}:${a.requestUrl}`.localeCompare(`${b.kind}:${b.requestUrl}`)) }),
      async commit() {
        checkAbort(signal);
        const bytes = `${JSON.stringify({ schemaVersion: 1, entries: [...entries.values()].sort((a, b) => `${a.kind}:${a.requestUrl}`.localeCompare(`${b.kind}:${b.requestUrl}`)) }, null, 2)}\n`;
        if (Buffer.byteLength(bytes) > 1024 * 1024) fail('FONT_LOCK_INVALID', 'Web-font lock exceeds 1 MiB.');
        const temporary = join(lease, 'lock.json');
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, lockPath);
      },
      close,
    };
  } catch (error) { await rm(join(lease, 'lock.json'), { force: true }); await close(); throw error; }
}

import { readFile } from 'node:fs/promises';

export class BuildError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'BuildError';
    this.code = code;
  }
}

export const PROFILE = 'native-window-v1';
export const LIMITATIONS = [
  'Experimental artifact creation is not a compatibility, performance or platform certification.',
  'Only the supplied current-host native-window-v1 player is packaged; no runtime is built or downloaded.',
  'No HTML/CSS integration, frontend command, custom plugin, inherited tsconfig, or runtime asset-copy workflow is provided.',
  'Computed imports, URLs, fetches, workers and other dynamic browser behavior remain unresolved; bundling cannot establish API support.',
  'The source snapshot excludes root .git and node_modules. Loaded dependency bytes are checked separately, not the entire dependency installation or all resolver configuration.',
  'Inputs and output parents must remain quiescent. Publication reserves a new directory and installs app.json last; process termination can leave an incomplete directory.',
  'Graceful cancellation waits for the current bundling/filesystem operation, then cleans staging and records source preservation; forced termination cannot guarantee cleanup.',
  'Source maps embed bundled source text. Review generated artifacts before distributing private projects.',
  'Input source-map chains that refer to originals outside measured bundler inputs are explicitly unsupported.',
  'Source maps are retained but the player does not yet remap generated stack locations.',
  'These unsigned local artifacts are not a release distribution; third-party notices, SBOM, signing and release verification remain open.',
];

export function hostTarget(platform = process.platform, architecture = process.arch) {
  const target = { 'darwin/arm64': 'macos-arm64', 'darwin/x64': 'macos-x64', 'linux/x64': 'linux-x64', 'win32/x64': 'windows-x64' }[`${platform}/${architecture}`];
  if (!target) throw new BuildError('UNSUPPORTED_HOST', `Unsupported packaging host: ${platform}/${architecture}`);
  return target;
}

export function validateTargets(targets, host) {
  if (targets !== undefined && targets !== host) throw new BuildError('UNSUPPORTED_TARGET', `Only the current host target ${host} is accepted, as one target.`);
}

export function portablePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:*?<>|"\p{Cc}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export async function readConfig(path) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch (cause) {
    throw new BuildError('INVALID_CONFIG', 'Expected valid 3jsn.json at the project root.', { cause });
  }
  const keys = ['schemaVersion', 'profile', 'name', 'entry'];
  if (!config || Array.isArray(config) || typeof config !== 'object'
    || Object.keys(config).length !== keys.length || keys.some(key => !Object.hasOwn(config, key))
    || config.schemaVersion !== 1 || config.profile !== PROFILE
    || typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(config.name)
    || ['app', 'metadata'].includes(config.name)
    || !portablePath(config.entry) || !/\.(?:js|mjs|ts)$/.test(config.entry)) {
    throw new BuildError('INVALID_CONFIG', '3jsn.json must contain only schemaVersion:1, profile:"native-window-v1", a portable safe name, and a contained relative .js/.mjs/.ts entry.');
  }
  return config;
}

export function validateDescription(value, target) {
  const backend = { macos: 'metal', linux: 'vulkan', windows: 'dx12' }[target.split('-')[0]];
  if (!value || Array.isArray(value) || value.schemaVersion !== 1
    || typeof value.playerVersion !== 'string' || !value.playerVersion || value.playerVersion.length > 128
    || !Array.isArray(value.packageVersions) || !value.packageVersions.includes(1)
    || !value.packageVersions.every(item => Number.isSafeInteger(item) && item > 0)
    || !Array.isArray(value.profiles) || !value.profiles.includes(PROFILE)
    || !value.profiles.every(item => typeof item === 'string')
    || value.target !== target || value.backend !== backend
    || typeof value.v8 !== 'string' || !value.v8 || value.v8.length > 128) {
    throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied player must describe package version 1, ${PROFILE}, target ${target}, and backend ${backend}.`);
  }
  return value;
}

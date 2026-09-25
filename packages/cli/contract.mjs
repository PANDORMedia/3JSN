import { readFile } from 'node:fs/promises';

export class BuildError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'BuildError';
    this.code = code;
  }
}

export const PROFILE = 'native-window-v1';
export const DOM_PROFILE = 'dom-window-v1';
const COMMON_LIMITATIONS = [
  'Experimental artifact creation is not a compatibility, performance or platform certification.',
  'Only an explicitly supplied current-host player is packaged; no runtime is built or downloaded.',
  'Computed imports, URLs, fetches, workers and other dynamic browser behavior remain unresolved; bundling cannot establish API support.',
  'The source snapshot excludes root .git and node_modules. Loaded dependency bytes are checked separately, not the entire dependency installation or all resolver configuration.',
  'Inputs and output parents must remain quiescent. Publication reserves a new directory and installs app.json last; process termination can leave an incomplete directory.',
  'Graceful cancellation waits for the current bundling/filesystem operation, then cleans staging and records source preservation; forced termination cannot guarantee cleanup.',
  'Source maps embed bundled source text. Review generated artifacts before distributing private projects.',
  'Input source-map chains that refer to originals outside measured bundler inputs are explicitly unsupported.',
  'Source maps are retained but the player does not yet remap generated stack locations.',
  'These unsigned local artifacts are not a release distribution; third-party notices, SBOM, signing and release verification remain open.',
];
export const LIMITATIONS = [...COMMON_LIMITATIONS,
  'The native-window-v1 profile packages statically imported raster images only; HTML/CSS resources, public-directory assets, dynamic asset discovery and general asset copying remain unsupported.',
  'The profile provides no frontend command, custom plugin or inherited tsconfig.',
];

export function limitationsFor(profile, { webFonts = false } = {}) {
  if (profile !== DOM_PROFILE) return LIMITATIONS;
  return [...COMMON_LIMITATIONS,
    'Interim interpreted-HTML profile: the native runtime still parses packaged HTML/CSS and maintains a dynamic DOM; this is not build-time UI compilation.',
    'Only an explicitly supplied current-host macOS Metal dom-window-v1 player, one #scene canvas, one local module and one explicit WOFF2 font are packaged.',
    webFonts
      ? 'Opt-in static CSS/font localization preserves rule order and descriptors; native font admission is separate. Other static resources and dynamic asset discovery remain unsupported.'
      : 'Static HTML and CSS resource references, foreign content, templates, classic/inline scripts and browser navigation are rejected; accepted syntax does not establish rendering or DOM API support.',
    'CSS animation and transition timelines are not advanced by the current DOM painter, even when declarations parse successfully.',
    'No frontend command, custom plugin, inherited tsconfig or general asset-copy workflow is provided. Dynamic HTML, CSS and asset requests from JavaScript remain unresolved.',
    'Font packaging validates the WOFF2 header and content identity, not decoding, licensing or glyph coverage.',
    ...(webFonts ? [
      'Localized CSS preserves original comments/notices and remote cache blobs preserve original bytes. Fetching a font does not establish redistribution rights; licensing and required notices remain a manual distribution gate.',
      'Font assets are copied without glyph subsetting; original provider queries remain unchanged. Native eager local loading does not certify browser font-display timing or FontFaceSet behavior.',
      'Pinned remote CSS/font bytes are reused without silent refresh. Offline mode fails on missing pins/blobs; forced termination may leave a cache lease that must be cleared after its owner stops.',
    ] : []),
  ];
}

export function validateProfileTarget(profile, target) {
  if (profile === DOM_PROFILE && !['macos-arm64', 'macos-x64'].includes(target)) {
    throw new BuildError('UNSUPPORTED_TARGET', 'dom-window-v1 currently accepts only a current-host macOS Metal player.');
  }
}

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
    || config.schemaVersion !== 1 || ![PROFILE, DOM_PROFILE].includes(config.profile)
    || typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(config.name)
    || ['app', 'metadata'].includes(config.name)
    || !portablePath(config.entry) || !(config.profile === DOM_PROFILE ? /\.html$/ : /\.(?:js|mjs|ts)$/).test(config.entry)) {
    throw new BuildError('INVALID_CONFIG', '3jsn.json must contain only schemaVersion:1, profile native-window-v1 (.js/.mjs/.ts) or dom-window-v1 (.html), a portable safe name, and a contained relative entry.');
  }
  return config;
}

export function validateDescription(value, target, profile = PROFILE) {
  const backend = { macos: 'metal', linux: 'vulkan', windows: 'dx12' }[target.split('-')[0]];
  if (!value || Array.isArray(value) || value.schemaVersion !== 1
    || typeof value.playerVersion !== 'string' || !value.playerVersion || value.playerVersion.length > 128
    || !Array.isArray(value.packageVersions) || !value.packageVersions.includes(1)
    || !value.packageVersions.every(item => Number.isSafeInteger(item) && item > 0)
    || !Array.isArray(value.profiles) || !value.profiles.includes(profile)
    || !value.profiles.every(item => typeof item === 'string')
    || value.target !== target || value.backend !== backend
    || typeof value.v8 !== 'string' || !value.v8 || value.v8.length > 128) {
    throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied player must describe package version 1, ${profile}, target ${target}, and backend ${backend}.`);
  }
  return value;
}

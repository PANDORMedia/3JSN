import { createHash } from 'node:crypto';
import { compileHtml, FORMAT, VERSION } from '../../experiments/compiled-ui/compiler.mjs';
import { BuildError } from './contract.mjs';

export function htmlParserMode(value = 'preserved') {
  if (!['preserved', 'restricted'].includes(value)) throw new BuildError('USAGE', '--html-parser must be preserved or restricted.');
  return value;
}

export function validateCompiledUiRuntime(description, mode) {
  const support = description.compiledUi;
  if (!support || support.format !== FORMAT || !Array.isArray(support.versions)
    || !support.versions.includes(VERSION) || !support.versions.every(version => Number.isSafeInteger(version) && version > 0)
    || support.htmlParser !== mode) {
    throw new BuildError('INCOMPATIBLE_RUNTIME', `The supplied player must support ${FORMAT} version ${VERSION} with HTML parser mode ${mode}.`);
  }
}

/** Compile the generated/localized input; original-source identity stays in build metadata. */
export function compilePackageUi(bytes, mode) {
  let ui;
  try {
    ui = compileHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { sourceName: 'generated/app/index.html' });
  } catch (cause) {
    throw new BuildError(`COMPILED_UI_${cause.code ?? 'INVALID'}`, cause.message, { cause });
  }
  const payload = Buffer.from(JSON.stringify(ui));
  const file = { path: 'app/ui.json', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
  const descriptor = { path: file.path, format: ui.format, version: ui.version, htmlParser: mode };
  return { payload, file, descriptor, metadata: { format: ui.format, version: ui.version, htmlParser: mode,
    source: ui.source, generated: file } };
}

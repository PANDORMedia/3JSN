import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';

export const LIMITS = Object.freeze({ inputBytes: 1_048_576, nodes: 10_000, attributes: 10_000, depth: 128, stringBytes: 65_536, diagnostics: 1_000, outputBytes: 16_777_216 });
export const FORMAT = '3jsn-static-ui-experiment';
export const VERSION = 1;

function fail(code, message, source = null) {
  throw Object.assign(new Error(message), { code, source });
}

/**
 * Experimental static document data, not a shipping package ABI. Parsing uses
 * the pinned parse5 dependency and Blitz's scripting-disabled initial-tree mode.
 * No scripts, styles, URLs or resources execute here. Recovered HTML parse errors
 * remain diagnostics; the native loader separately rejects unsupported modes
 * and construction capabilities rather than changing this parser-owned tree.
 * Input bytes are bounded before parsing; tree/attribute bounds apply afterward
 * before copying locations, then string bounds apply. These are artifact bounds, not parser
 * peak-memory or wall-time guarantees. Output size is checked after serialization.
 * Locations are parse5 UTF-16 offsets, not byte offsets; implied nodes have null
 * locations and even explicit merged attributes may have no individual range.
 * One leading BOM is skipped for parsing; ranges/columns are shifted back to
 * the original input. Hashes always cover the original UTF-8 bytes. Every child
 * and template-content reference points forward in the flat preorder node array.
 * The caller owns source-file I/O and must leave its input unchanged.
 */
export function compileHtml(html, { sourceName = 'document.html', limits = {} } = {}) {
  if (typeof html !== 'string' || typeof sourceName !== 'string') {
    fail('INVALID_INPUT', 'HTML and sourceName must be strings.');
  }
  if (!html.isWellFormed() || !sourceName.isWellFormed()) {
    fail('INVALID_UNICODE', 'HTML and sourceName must not contain unpaired UTF-16 surrogates.');
  }
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) fail('INVALID_LIMIT', 'limits must be an object.');
  const bounds = { ...LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) {
      fail('INVALID_LIMIT', `Limit ${key} must be a positive integer no greater than ${LIMITS[key] ?? 'a known limit'}.`);
    }
    bounds[key] = value;
  }
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength > bounds.inputBytes) fail('INPUT_LIMIT', `HTML exceeds ${bounds.inputBytes} UTF-8 bytes.`);
  function checked(value, source = null) {
    if (value !== null && Buffer.byteLength(value, 'utf8') > bounds.stringBytes) {
      fail('STRING_LIMIT', `Tree string exceeds ${bounds.stringBytes} UTF-8 bytes.`, source);
    }
    return value;
  }
  checked(sourceName);
  const bom = html.startsWith('\ufeff');
  function provenance(value) {
    if (!value) return null;
    const copy = structuredClone(value);
    if (bom) {
      const pending = [copy];
      const seen = new Set();
      while (pending.length) {
        const location = pending.pop();
        if (seen.has(location)) continue;
        seen.add(location);
        for (const key of ['start', 'end']) {
          if (typeof location[`${key}Offset`] === 'number' && location[`${key}Offset`] >= 0) location[`${key}Offset`]++;
          if (location[`${key}Line`] === 1 && location[`${key}Col`] >= 1) location[`${key}Col`]++;
        }
        for (const item of Object.values(location)) if (item && typeof item === 'object') pending.push(item);
      }
    }
    return copy;
  }
  const diagnostics = [];
  let diagnosticsTotal = 0;
  const document = parse(bom ? html.slice(1) : html, {
    scriptingEnabled: false,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      diagnosticsTotal++;
      if (diagnostics.length < bounds.diagnostics) diagnostics.push(provenance(error));
    },
  });
  const nodes = [];
  let attributes = 0;
  const pending = [{ node: document, parent: null, depth: 0 }];
  while (pending.length) {
    const { node, parent, depth, templateOwner } = pending.pop();
    if (depth > bounds.depth) fail('DEPTH_LIMIT', `Tree depth exceeds ${bounds.depth}.`);
    if (nodes.length >= bounds.nodes) fail('NODE_LIMIT', `Tree exceeds ${bounds.nodes} nodes.`);
    attributes += node.attrs?.length ?? 0;
    if (attributes > bounds.attributes) fail('ATTRIBUTE_LIMIT', `Tree exceeds ${bounds.attributes} attributes.`);
    const source = provenance(node.sourceCodeLocation);
    let record;
    if (node.nodeName === '#document') record = { kind: 'document', children: [], source };
    else if (node.nodeName === '#document-fragment') record = { kind: 'fragment', children: [], source };
    else if (node.nodeName === '#text') record = { kind: 'text', value: checked(node.value, source), source };
    else if (node.nodeName === '#comment') record = { kind: 'comment', value: checked(node.data, source), source };
    else if (node.nodeName === '#documentType') record = {
      kind: 'doctype', name: checked(node.name, source), publicId: checked(node.publicId, source),
      systemId: checked(node.systemId, source), source,
    };
    else if (node.tagName) {
      record = {
        kind: 'element', name: checked(node.tagName, source), namespace: checked(node.namespaceURI, source), prefix: null,
        attributes: node.attrs.map(attr => ({ name: checked(attr.name, source), namespace: checked(attr.namespace ?? null, source),
          prefix: checked(attr.prefix ?? null, source), value: checked(attr.value, source) })),
        children: [], source,
      };
    } else fail('UNSUPPORTED_NODE', `Unsupported parsed node ${node.nodeName}.`, source);
    const index = nodes.length;
    nodes.push(record);
    if (parent !== null) nodes[parent].children.push(index);
    if (templateOwner !== undefined) nodes[templateOwner].templateContents = index;
    if (node.content) pending.push({ node: node.content, parent: null, templateOwner: index, depth: depth + 1 });
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], parent: index, depth: depth + 1 });
  }
  const result = {
    format: FORMAT, version: VERSION,
    source: { name: sourceName, sha256: createHash('sha256').update(html, 'utf8').digest('hex'), byteLength },
    document: { mode: document.mode, scriptingEnabled: false }, nodes, diagnostics,
    diagnosticsTotal, diagnosticsTruncated: diagnosticsTotal > diagnostics.length,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > bounds.outputBytes) fail('OUTPUT_LIMIT', `Serialized tree exceeds ${bounds.outputBytes} UTF-8 bytes.`);
  return result;
}

async function readBoundedInput(path) {
  // Nonblocking open prevents a named pipe from waiting for a writer before
  // the regular-file check. Reads remain bounded if the file grows after stat.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) fail('INVALID_INPUT_FILE', 'HTML input must be a regular file.');
    const buffer = Buffer.alloc(LIMITS.inputBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > LIMITS.inputBytes) fail('INPUT_LIMIT', `HTML exceeds ${LIMITS.inputBytes} UTF-8 bytes.`);
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

if (isMain()) {
  try {
    const [input, output, ...extra] = process.argv.slice(2);
    if (!input || !output || extra.length) fail('USAGE', 'Usage: node experiments/compiled-ui/compiler.mjs INPUT.html OUTPUT.json');
    if (resolve(input) === resolve(output)) fail('OUTPUT_IS_SOURCE', 'Output must differ from the original HTML source.');
    const bytes = await readBoundedInput(input);
    let html;
    try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('INVALID_ENCODING', 'The experiment accepts UTF-8 HTML files only.'); }
    const result = compileHtml(html, { sourceName: input });
    // Exclusive creation also rejects existing hardlinks/symlinks to source files.
    await writeFile(output, `${JSON.stringify(result)}\n`, { flag: 'wx' });
  } catch (error) {
    console.error(`${error.code ?? 'COMPILE_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  }
}

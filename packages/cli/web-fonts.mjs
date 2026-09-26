import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, ident, lexer, parse, walk } from 'css-tree';
import { BuildError } from './contract.mjs';
import { analyzeHtml, renderHtml } from './html.mjs';
import { openWebFontCache, WEB_FONT_LIMITS } from './web-font-cache.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new BuildError(code, message); };
const contextual = (error, context) => new BuildError(error.code ?? 'FONT_RESOURCE_FAILED',
  `${error.message} (${context})`, { cause: error });
const named = node => ident.decode(node.name ?? node.property ?? '').toLowerCase();
const ordinaryFunctions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'var',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient']);

function resourceUrl(value, base, allowInlineFont = false) {
  if (!value || /[\p{Cc}\\]/u.test(value)) fail('FONT_URL_INVALID', 'CSS/font URL is empty or contains unsupported controls/backslashes.');
  let url;
  try { url = new URL(value, base); } catch (cause) { throw new BuildError('FONT_URL_INVALID', 'Cannot resolve CSS/font URL.', { cause }); }
  if ((!['file:', 'http:', 'https:'].includes(url.protocol) && !(allowInlineFont && url.protocol === 'data:')) || url.username || url.password || url.hash
    || (new URL(base).protocol !== 'file:' && url.protocol === 'file:')) fail('FONT_URL_INVALID', 'CSS/font resource uses an unsupported URL scheme, credentials or fragment.');
  return url.href;
}

function urlValue(node) {
  if (node.type === 'Url') return node.value;
  if (node.type === 'Function' && named(node) === 'url') {
    const children = [...node.children];
    if (children.length === 1 && children[0].type === 'String') return children[0].value;
  }
  return undefined;
}

function inspectCss(source, origin) {
  let ast;
  try { ast = parse(source, { positions: true, parseCustomProperty: true, onParseError: error => { throw error; } }); } catch (cause) {
    throw new BuildError('FONT_CSS_INVALID', `Stylesheet cannot be parsed without recovery: ${origin}`, { cause });
  }
  const urls = new Set(), sourceFunctions = new Set(), imports = [], faces = [], containers = [];
  let priorRule = false, ruleDepth = 0;
  for (const node of ast.children) {
    if (node.type === 'Atrule' && named(node) === 'import') {
      if (priorRule) fail('FONT_CSS_INVALID', 'An @import after an ordinary rule would be ignored by browsers; localization refuses it.');
    } else if (!(node.type === 'Atrule' && (named(node) === 'charset' || (named(node) === 'layer' && !node.block)))) priorRule = true;
  }
  walk(ast, {
    enter(node) {
      if (node.type === 'Rule') ruleDepth++;
      if (node.type === 'Raw') fail('FONT_CSS_INVALID', 'Unparsed CSS is outside the font localization contract.');
      if (node.type === 'Atrule') {
        const name = named(node);
        if (!['import', 'font-face', 'media', 'supports', 'layer', 'charset', 'keyframes', '-webkit-keyframes'].includes(name)) fail('FONT_CSS_UNSUPPORTED', `Unsupported CSS at-rule @${name}.`);
        if (name === 'charset') {
          const parts = [...(node.prelude?.children ?? [])];
          if (parts.length !== 1 || parts[0].type !== 'String' || parts[0].value.toLowerCase() !== 'utf-8') fail('FONT_CSS_ENCODING', 'Only UTF-8 CSS is accepted.');
        }
        if (name === 'import') {
          if (containers.length || ruleDepth) fail('FONT_CSS_INVALID', '@import must be at stylesheet root.');
          const parts = [...(node.prelude?.children ?? [])], first = parts[0];
          if (!first || (first.type !== 'String' && urlValue(first) === undefined) || node.block
            || lexer.matchAtrulePrelude('import', node.prelude).error) fail('FONT_CSS_INVALID', 'Unsupported or invalid @import prelude.');
          urls.add(first);
          walk(node.prelude, part => { if (part.type === 'Function') sourceFunctions.add(part); });
          imports.push({ node: first, value: first.type === 'String' ? first.value : urlValue(first), conditions: parts.slice(1).map(generate).join(' ') });
        }
        if (name === 'font-face') {
          if (ruleDepth) fail('FONT_CSS_INVALID', '@font-face cannot be nested inside a style rule.');
          if (node.prelude || !node.block) fail('FONT_CSS_INVALID', 'Malformed @font-face.');
          const descriptors = [], sources = [];
          for (const declaration of node.block.children) {
            if (declaration.type !== 'Declaration' || declaration.important) fail('FONT_CSS_INVALID', 'A font face must contain ordinary descriptors without !important.');
            const property = named(declaration);
            descriptors.push({ name: property, value: generate(declaration.value) });
            if (property === 'src') {
              let current;
              for (const part of declaration.value.children) {
                if (urlValue(part) !== undefined) {
                  if (current) fail('FONT_CSS_INVALID', 'Font sources must be comma-separated.');
                  urls.add(part); current = { type: 'url', node: part, value: urlValue(part) }; sources.push(current);
                }
                else if (part.type === 'Function' && ['local', 'format', 'tech'].includes(named(part))) {
                  sourceFunctions.add(part);
                  if (named(part) === 'local') {
                    if (current) fail('FONT_CSS_INVALID', 'Font sources must be comma-separated.');
                    current = { type: 'local', value: generate(part) }; sources.push(current);
                  } else {
                    if (!current || current.type !== 'url') fail('FONT_CSS_INVALID', 'Font format/technology hints must follow a URL source.');
                    current[named(part)] = [...part.children].filter(child => child.type !== 'Operator').map(child => child.type === 'String' ? child.value.toLowerCase() : ident.decode(child.name ?? '').toLowerCase());
                  }
                } else if (part.type === 'Operator' && part.value === ',') {
                  if (!current) fail('FONT_CSS_INVALID', 'Empty font source.');
                  current = undefined;
                } else fail('FONT_CSS_INVALID', 'Unsupported font source syntax.');
              }
              if (!current) fail('FONT_CSS_INVALID', 'Empty font source.');
            }
          }
          if (!descriptors.some(item => item.name === 'font-family') || !sources.length) fail('FONT_CSS_INVALID', 'Font faces require a family and at least one source.');
          faces.push({ descriptors, sources, location: node.loc.start, conditions: containers.map(item => ({ ...item })) });
        }
        containers.push({ name, prelude: node.prelude ? generate(node.prelude) : '' });
      }
      if (node.type === 'Url' || (node.type === 'Function' && named(node) === 'url')) {
        if (!urls.has(node)) fail('NON_FONT_RESOURCE', 'CSS URLs outside @font-face src and @import require general asset support.');
      }
      if (node.type === 'Function' && !urls.has(node) && !sourceFunctions.has(node) && !ordinaryFunctions.has(named(node))) {
        fail('FONT_CSS_UNSUPPORTED', `CSS function ${named(node)} is outside the resource-free declaration contract.`);
      }
    },
    leave(node) { if (node.type === 'Atrule') containers.pop(); if (node.type === 'Rule') ruleDepth--; },
  });
  return { imports, faces };
}

function fontFormat(bytes) {
  const tag = bytes.toString('ascii', 0, 4);
  if (tag === 'wOF2' || tag === 'wOFF') {
    const header = tag === 'wOF2' ? 48 : 44;
    if (bytes.length < header || bytes.readUInt32BE(8) !== bytes.length || !bytes.readUInt16BE(12)
      || bytes.readUInt16BE(14) !== 0 || !bytes.readUInt32BE(16)
      || (tag === 'wOFF' && header + bytes.readUInt16BE(12) * 20 > bytes.length)
      || (tag === 'wOF2' && (!bytes.readUInt32BE(20) || bytes.readUInt32BE(20) > bytes.length - header))) fail('FONT_FORMAT_INVALID', 'WOFF/WOFF2 header is incoherent.');
    return tag === 'wOF2' ? 'woff2' : 'woff';
  }
  if (bytes.length >= 12 && (tag === 'OTTO' || bytes.readUInt32BE(0) === 0x00010000 || tag === 'true')) {
    const tables = bytes.readUInt16BE(4);
    if (!tables || 12 + tables * 16 > bytes.length) fail('FONT_FORMAT_INVALID', 'SFNT font table directory is incoherent.');
    for (let index = 0; index < tables; index++) {
      const start = 12 + index * 16;
      if (bytes.readUInt32BE(start + 8) + bytes.readUInt32BE(start + 12) > bytes.length) fail('FONT_FORMAT_INVALID', 'SFNT font table leaves the supplied bytes.');
    }
    return tag === 'OTTO' ? 'otf' : 'ttf';
  }
  fail('FONT_FORMAT_INVALID', 'Expected a coherent TTF, OTF, WOFF or WOFF2 resource.');
}

function decodeCss(resource) {
  const type = resource.provenance.response?.contentType ?? '';
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1];
  if (charset && charset.toLowerCase() !== 'utf-8') fail('FONT_CSS_ENCODING', 'Only UTF-8 stylesheets can be localized.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes); } catch (cause) {
    throw new BuildError('FONT_CSS_ENCODING', 'Stylesheet is not valid UTF-8.', { cause });
  }
}

/** Localize the CSS/font graph without publishing a package or editing the project. */
export async function localizeWebFonts({ projectRoot, outputDir, htmlEntry, htmlBytes, stateDir, offline = false, signal,
  limits = WEB_FONT_LIMITS, fontPolicy, protectedRoots = [] }, { fetchImpl = globalThis.fetch } = {}) {
  const analysis = analyzeHtml(htmlBytes, htmlEntry, { webFonts: true });
  const cache = await openWebFontCache({ projectRoot, outputDir, stateDir, offline, signal, limits, protectedRoots, fetchImpl });
  limits = cache.limits;
  const files = new Map(), sheets = new Map(), provenance = [], requirements = [], replacements = [];
  let htmlBase, outputBytes = 0;
  const addFile = (path, bytes, kind) => {
    if (!files.has(path)) {
      const byteLimit = kind === 'stylesheet' ? limits.stylesheetBytes : limits.fontBytes;
      if (bytes.length > byteLimit || outputBytes + bytes.length > limits.totalBytes || files.size >= limits.resources) {
        fail('FONT_RESOURCE_LIMIT', `Generated CSS/font resources exceed the package limits: ${path}`);
      }
      outputBytes += bytes.length;
      files.set(path, { path, kind, payload: bytes, bytes: bytes.length, sha256: hash(bytes) });
    }
    return path;
  };
  try {
    htmlBase = pathToFileURL(join(await realpath(projectRoot), htmlEntry)).href;
    async function stylesheet(value, base, stack, inheritedConditions, depth = 0) {
      const url = resourceUrl(value, base);
      if (depth >= limits.importDepth) fail('FONT_RESOURCE_LIMIT', 'Stylesheet import depth exceeded.');
      if (stack.includes(url)) fail('FONT_IMPORT_CYCLE', 'Stylesheet imports contain a cycle.');
      let resource;
      try { resource = await cache.read(url, 'stylesheet'); } catch (error) {
        throw contextual(error, `stylesheet request ${url}, referenced from ${base}`);
      }
      if (stack.includes(resource.finalUrl)) fail('FONT_IMPORT_CYCLE', 'Redirected stylesheet imports contain a cycle.');
      const key = `${url}:${JSON.stringify(inheritedConditions)}`;
      if (sheets.has(key)) return sheets.get(key);
      provenance.push(resource.provenance);
      let source;
      try { source = decodeCss(resource); } catch (error) { throw contextual(error, `stylesheet ${resource.finalUrl}`); }
      const css = await transformCss(source, resource.finalUrl, false, [...stack, url, ...(url !== resource.finalUrl ? [resource.finalUrl] : [])], inheritedConditions, depth + 1);
      const bytes = Buffer.from(css), path = addFile(`app/styles/${hash(bytes)}.css`, bytes, 'stylesheet');
      sheets.set(key, path);
      return path;
    }
    async function transformCss(source, base, inline, stack, inheritedConditions, depth = 0) {
      if (Buffer.byteLength(source) > limits.stylesheetBytes) fail('FONT_RESOURCE_LIMIT', 'Inline/imported stylesheet exceeds its byte limit.');
      const inspected = inspectCss(source, base), edits = [];
      for (const imported of inspected.imports) {
        let path;
        try { path = await stylesheet(imported.value, base, stack, [...inheritedConditions, ...(imported.conditions ? [{ name: 'import', prelude: imported.conditions }] : [])], depth); } catch (error) {
          throw contextual(error, `@import in ${base}:${imported.node.loc.start.line}:${imported.node.loc.start.column}`);
        }
        edits.push({ node: imported.node, text: `url("${inline ? './styles/' : './'}${path.split('/').at(-1)}")` });
      }
      for (const face of inspected.faces) {
        const requirement = { stylesheet: base, descriptors: face.descriptors, conditions: [...inheritedConditions, ...face.conditions],
          sources: face.sources.map(({ node: _node, ...item }) => item) };
        requirements.push(requirement);
        if (fontPolicy) {
          try { fontPolicy(requirement); } catch (error) { throw contextual(error, `@font-face in ${base}:${face.location.line}:${face.location.column}`); }
        }
        for (const [sourceIndex, item] of face.sources.entries()) {
          if (item.type !== 'url') continue;
          const url = resourceUrl(item.value, base, true);
          let resource, format;
          try {
            resource = await cache.read(url, 'font');
            format = fontFormat(resource.bytes);
            const inlineTypeFormats = { 'font/woff': ['woff'], 'application/font-woff': ['woff'], 'application/x-font-woff': ['woff'],
              'font/woff2': ['woff2'], 'application/font-woff2': ['woff2'], 'application/x-font-woff2': ['woff2'],
              'font/ttf': ['ttf'], 'application/x-font-ttf': ['ttf'], 'application/x-font-truetype': ['ttf'],
              'font/otf': ['otf'], 'application/x-font-opentype': ['otf'], 'application/vnd.ms-opentype': ['otf'],
              'application/font-sfnt': ['ttf', 'otf'] };
            const inlineType = resource.provenance.inlineData?.contentType;
            if (inlineType && !inlineTypeFormats[inlineType]?.includes(format)) {
              fail('FONT_FORMAT_INVALID', 'Inline font MIME type does not match the font container format.');
            }
            if (item.format && !item.format.some(hint => ({ woff2: ['woff2'], woff: ['woff'], truetype: ['ttf'], opentype: ['ttf', 'otf'] }[hint] ?? []).includes(format))) {
              fail('FONT_FORMAT_INVALID', 'Font bytes do not match their declared format hint.');
            }
          } catch (error) {
            const label = url.startsWith('data:') ? url.slice(0, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(',')) : url;
            throw contextual(error, `font request ${label}, src in ${base}:${item.node.loc.start.line}:${item.node.loc.start.column}`);
          }
          if (resource.provenance.inlineData) {
            requirement.sources[sourceIndex] = { ...requirement.sources[sourceIndex], value: resource.finalUrl };
            const srcDescriptor = requirement.descriptors.find(descriptor => descriptor.name === 'src');
            if (srcDescriptor) srcDescriptor.value = srcDescriptor.value.replace(item.value, resource.finalUrl);
          }
          const path = addFile(`app/fonts/${hash(resource.bytes)}.${format}`, resource.bytes, 'font');
          provenance.push(resource.provenance);
          edits.push({ node: item.node, text: `url("${inline ? './fonts/' : '../fonts/'}${path.split('/').at(-1)}")` });
        }
      }
      let generated = source, boundary = generated.length;
      for (const edit of edits.sort((a, b) => b.node.loc.start.offset - a.node.loc.start.offset)) {
        const { start, end } = edit.node.loc;
        if (end.offset > boundary) fail('FONT_CSS_INVALID', 'CSS rewrite locations overlap.');
        generated = generated.slice(0, start.offset) + edit.text + generated.slice(end.offset); boundary = start.offset;
      }
      if (Buffer.byteLength(generated) > limits.stylesheetBytes) fail('FONT_RESOURCE_LIMIT', `Generated stylesheet exceeds its byte limit: ${base}`);
      inspectCss(generated, base);
      return generated;
    }
    for (const slot of analysis.styles) {
      if (slot.kind === 'linked') {
        const path = await stylesheet(slot.href, htmlBase, [], []);
        replacements.push({ ...slot, text: `href="./styles/${path.split('/').at(-1)}"` });
      } else replacements.push({ ...slot, text: await transformCss(slot.css, htmlBase, true, [], []) });
    }
    const generatedHtml = renderHtml(analysis, replacements);
    await cache.commit();
    return { entry: analysis.entry, bytes: generatedHtml,
      metadata: { ...analysis.metadata, rewrite: 'Generated module src and static stylesheet/font URLs are localized; source files are untouched.',
        grammar: 'Opt-in CSS/font localization extends the interim HTML grammar with ordinary stylesheet links, imported CSS and preserved @font-face rules; native font semantics require a separate capability gate.' },
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      sourceInputs: [...cache.sourceInputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
      provenance, requirements, lock: cache.usedLock(), stateDir: cache.stateDir };
  } finally { await cache.close(); }
}

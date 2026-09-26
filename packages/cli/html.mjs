import { posix } from 'node:path';
import { parse as parseHtml } from 'parse5';
import { parse as parseCss, walk } from 'css-tree';
import { BuildError, portablePath } from './contract.mjs';

const elements = new Set(('html head body title meta style script main header footer section article nav aside div span p '
  + 'h1 h2 h3 h4 h5 h6 button canvas ul ol li dl dt dd br hr strong em b i u s small code pre sub sup blockquote').split(' '));
const attributes = new Set(['id', 'class', 'title', 'lang', 'dir', 'role', 'style']);
const elementAttributes = {
  script: new Set(['type', 'src']), meta: new Set(['charset', 'name', 'content']),
  canvas: new Set(['width', 'height']), button: new Set(['type', 'disabled']),
};
const cssFunctions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'var',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient']);
const reject = message => { throw new BuildError('UNSUPPORTED_HTML', message); };
const textOf = node => node.childNodes.filter(child => child.nodeName === '#text').map(child => child.value).join('');

function checkCss(source, context) {
  if (source.includes('\\')) reject('CSS escapes are outside the interim HTML profile.');
  let ast;
  try { ast = parseCss(source, { context, parseCustomProperty: true, onParseError: error => { throw error; } }); } catch (cause) {
    throw new BuildError('UNSUPPORTED_CSS', 'CSS must parse without recovery in the interim HTML profile.', { cause });
  }
  walk(ast, node => {
    if (['Atrule', 'Url', 'Raw'].includes(node.type)
      || (node.type === 'Function' && !cssFunctions.has(node.name.toLowerCase()))) {
      throw new BuildError('UNSUPPORTED_CSS', `CSS ${node.type}${node.name ? ` ${node.name}` : ''} is outside the resource-free interim profile.`);
    }
  });
}

function inspect(source, { webFonts = false, externalStylesheets = false } = {}) {
  if (/<\?xml(?:\s|\?)/i.test(source)) reject('XML declarations are not supported.');
  // Pinned Blitz sniffs the entire first DOCTYPE line, including later comments.
  if (source.startsWith('<!DOCTYPE') && /XHTML|xhtml/.test(source.split('\n', 1)[0])) reject('This first DOCTYPE line triggers the native XHTML parser.');
  const errors = [];
  const document = parseHtml(source, { sourceCodeLocationInfo: true, scriptingEnabled: true, onParseError: error => errors.push(error) });
  if (errors.length) reject(`HTML must parse without errors: ${errors[0].code}.`);
  const doctype = document.childNodes.find(node => node.nodeName === '#documentType');
  if (document.mode !== 'no-quirks' || !doctype || doctype.name !== 'html' || doctype.publicId || doctype.systemId) {
    reject('An ordinary HTML5 <!doctype html> document in no-quirks mode is required.');
  }
  const scripts = [], canvases = [], sceneIds = [], styles = [];
  function visit(node) {
    if (node.tagName) {
      const isLink = (webFonts || externalStylesheets) && node.tagName === 'link';
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !(elements.has(node.tagName) || isLink)) reject(`Element <${node.tagName}> is outside the interim HTML profile.`);
      for (const attr of node.attrs) {
        if (attr.namespace || attr.prefix || !((attributes.has(attr.name) || /^(?:aria|data)-[a-z0-9-]+$/.test(attr.name))
          || elementAttributes[node.tagName]?.has(attr.name) || (isLink && ['rel', 'href', 'type'].includes(attr.name)))) reject(`Attribute ${attr.name} on <${node.tagName}> is outside the interim HTML profile.`);
        if (attr.name === 'style') checkCss(attr.value, 'declarationList');
        if (attr.name === 'id' && attr.value === 'scene') sceneIds.push(node);
        if (attr.name === 'charset' && attr.value.toLowerCase() !== 'utf-8') reject('Only UTF-8 HTML is supported.');
      }
      if (node.tagName === 'style') {
        const css = textOf(node);
        // Blitz decodes semicolon-terminated entities in raw style text; browsers do not.
        if (/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.test(css)) reject('Character references in raw <style> text are unsupported.');
        if (webFonts) {
          if (!node.sourceCodeLocation?.endTag) reject('Style elements require an explicit closing tag.');
          styles.push({ kind: 'inline', css, start: node.sourceCodeLocation.startTag.endOffset, end: node.sourceCodeLocation.endTag.startOffset });
        }
        else checkCss(css, 'stylesheet');
      }
      if (isLink) {
        const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
        if (attrs.rel !== 'stylesheet' || !attrs.href || (attrs.type !== undefined && attrs.type.toLowerCase() !== 'text/css')) reject('Only ordinary rel="stylesheet" links without alternate/media controls are accepted.');
        const location = node.sourceCodeLocation?.attrs?.href;
        if (!location) reject('Stylesheet href must have an explicit source location.');
        styles.push({ kind: 'linked', href: attrs.href, start: location.startOffset, end: location.endOffset });
      }
      if (node.tagName === 'script') scripts.push(node);
      if (node.tagName === 'canvas') canvases.push(node);
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  if (canvases.length !== 1 || sceneIds.length !== 1 || canvases[0] !== sceneIds[0]) reject('Exactly one canvas, with the unique id="scene", is required.');
  if (canvases[0].childNodes.some(node => node.nodeName !== '#comment' && !(node.nodeName === '#text' && !node.value.trim()))) reject('Canvas fallback content is outside the interim HTML profile.');
  if (scripts.length !== 1) reject('Exactly one external local module script is required.');
  const script = scripts[0];
  const attrs = Object.fromEntries(script.attrs.map(attr => [attr.name, attr.value]));
  if (attrs.type?.toLowerCase() !== 'module' || !attrs.src || textOf(script).trim()) reject('The script must have type="module", a local src, and no inline code.');
  const location = script.sourceCodeLocation?.attrs?.src;
  if (!location) reject('The script src must have an explicit source location.');
  return { src: attrs.src, location, styles };
}

function modulePath(htmlPath, src) {
  if (/[\\:%?#\s\p{Cc}]/u.test(src) || src.startsWith('/')) reject('Module src must be a plain local relative path without URL encoding, query or fragment.');
  const path = posix.normalize(posix.join(posix.dirname(htmlPath), src));
  if (!portablePath(path) || !/\.(?:js|mjs|ts)$/.test(path)) reject('Module src must resolve to a contained relative .js/.mjs/.ts path.');
  return path;
}

/** Validate a bounded static document and rewrite only its generated module src. No source file is changed. */
export function analyzeHtml(bytes, htmlPath, { webFonts = false, externalStylesheets = false } = {}) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (cause) {
    throw new BuildError('INVALID_HTML_ENCODING', 'HTML must be valid UTF-8.', { cause });
  }
  if (source.startsWith('\ufeff')) reject('UTF-8 BOMs are outside the interim HTML profile.');
  const { src, location, styles } = inspect(source, { webFonts, externalStylesheets });
  const entry = modulePath(htmlPath, src);
  return { source, entry, location, styles, webFonts, externalStylesheets, metadata: { interpretation: 'interim-runtime-html-css',
    parsers: { html: 'parse5@8.0.1', css: 'css-tree@3.2.1' },
    originalModuleSrc: src, moduleEntry: entry, rewrite: 'Only the module src attribute is replaced in generated HTML.',
    grammar: `HTML5 no-quirks UTF-8 without BOM; ordinary text/structural elements, one unique #scene canvas and one local external module; plain inline CSS with no at-rules, URLs, escapes, parse recovery or unlisted functions. No templates, noscript, foreign content, navigation or inline handlers.${webFonts || externalStylesheets ? ' Ordinary linked stylesheets are recorded as package resources.' : ' Static resources are not admitted.'}` } };
}

export function renderHtml(analysis, replacements = []) {
  const edits = [{ start: analysis.location.startOffset, end: analysis.location.endOffset, text: 'src="./main.mjs"' }, ...replacements].sort((a, b) => b.start - a.start);
  let generated = analysis.source, boundary = generated.length;
  for (const edit of edits) {
    if (edit.start < 0 || edit.end > boundary || edit.start > edit.end) reject('Generated HTML edits overlap or escape the input.');
    generated = generated.slice(0, edit.start) + edit.text + generated.slice(edit.end); boundary = edit.start;
  }
  if (inspect(generated, { webFonts: analysis.webFonts, externalStylesheets: analysis.externalStylesheets }).src !== './main.mjs') reject('Generated module src verification failed.');
  return Buffer.from(generated);
}

export function validatePackagedStylesheet(bytes, path) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (cause) {
    throw new BuildError('INVALID_VITE_CSS', `Vite stylesheet is not valid UTF-8: ${path}`, { cause });
  }
  let ast;
  try { ast = parseCss(source, { context: 'stylesheet', onParseError: error => { throw error; } }); } catch (cause) {
    throw new BuildError('INVALID_VITE_CSS', `Vite stylesheet cannot be parsed without recovery: ${path}`, { cause });
  }
  walk(ast, node => {
    if (node.type === 'Url' || (node.type === 'Atrule' && ['import', 'font-face'].includes(node.name.toLowerCase()))) {
      throw new BuildError('UNSUPPORTED_VITE_CSS_RESOURCE', `Vite stylesheet has a URL, import or font-face rule outside the packaged resource graph: ${path}`);
    }
  });
  return source;
}

export function prepareHtml(bytes, htmlPath) {
  const analysis = analyzeHtml(bytes, htmlPath);
  return { entry: analysis.entry, bytes: renderHtml(analysis), metadata: analysis.metadata };
}

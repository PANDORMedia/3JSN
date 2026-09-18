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

function inspect(source) {
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
  const scripts = [], canvases = [], sceneIds = [];
  function visit(node) {
    if (node.tagName) {
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !elements.has(node.tagName)) reject(`Element <${node.tagName}> is outside the interim HTML profile.`);
      for (const attr of node.attrs) {
        if (attr.namespace || attr.prefix || !((attributes.has(attr.name) || /^(?:aria|data)-[a-z0-9-]+$/.test(attr.name))
          || elementAttributes[node.tagName]?.has(attr.name))) reject(`Attribute ${attr.name} on <${node.tagName}> is outside the interim HTML profile.`);
        if (attr.name === 'style') checkCss(attr.value, 'declarationList');
        if (attr.name === 'id' && attr.value === 'scene') sceneIds.push(node);
        if (attr.name === 'charset' && attr.value.toLowerCase() !== 'utf-8') reject('Only UTF-8 HTML is supported.');
      }
      if (node.tagName === 'style') {
        const css = textOf(node);
        // Blitz decodes semicolon-terminated entities in raw style text; browsers do not.
        if (/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.test(css)) reject('Character references in raw <style> text are unsupported.');
        checkCss(css, 'stylesheet');
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
  return { src: attrs.src, location };
}

function modulePath(htmlPath, src) {
  if (/[\\:%?#\s\p{Cc}]/u.test(src) || src.startsWith('/')) reject('Module src must be a plain local relative path without URL encoding, query or fragment.');
  const path = posix.normalize(posix.join(posix.dirname(htmlPath), src));
  if (!portablePath(path) || !/\.(?:js|mjs|ts)$/.test(path)) reject('Module src must resolve to a contained relative .js/.mjs/.ts path.');
  return path;
}

/** Validate a bounded static document and rewrite only its generated module src. No source file is changed. */
export function prepareHtml(bytes, htmlPath) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (cause) {
    throw new BuildError('INVALID_HTML_ENCODING', 'HTML must be valid UTF-8.', { cause });
  }
  if (source.startsWith('\ufeff')) reject('UTF-8 BOMs are outside the interim HTML profile.');
  const { src, location } = inspect(source);
  const entry = modulePath(htmlPath, src);
  const generated = source.slice(0, location.startOffset) + 'src="./main.mjs"' + source.slice(location.endOffset);
  if (inspect(generated).src !== './main.mjs') reject('Generated module src verification failed.');
  return { entry, bytes: Buffer.from(generated), metadata: { interpretation: 'interim-runtime-html-css',
    parsers: { html: 'parse5@8.0.1', css: 'css-tree@3.2.1' },
    originalModuleSrc: src, moduleEntry: entry, rewrite: 'Only the module src attribute is replaced in generated HTML.',
    grammar: 'HTML5 no-quirks UTF-8 without BOM; ordinary text/structural elements, one unique #scene canvas and one local external module; plain inline CSS with no at-rules, URLs, escapes, parse recovery or unlisted functions. No templates, noscript, foreign content, navigation, inline handlers or static resources.' } };
}

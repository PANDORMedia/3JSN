import { parse } from 'parse5';
import * as css from 'css-tree';

const packageName = value => typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value) ? value : undefined;
const location = (path, node) => ({ path, line: node?.startLine ?? node?.line ?? 1, column: node?.startCol ?? node?.column ?? 1 });
const names = object => object && typeof object === 'object' && !Array.isArray(object) ? Object.keys(object).filter(name => packageName(name)).sort() : [];

// Public reports retain a resource identity, never credentials or URL payloads.
function safeUrl(value) {
  if (typeof value !== 'string' || value.includes('\\') || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    try {
      const url = new URL(value, 'https://discovery.invalid');
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return value.startsWith('//') ? `//${url.host}${url.pathname}` : url.href;
    } catch { return undefined; }
  }
  return value.split(/[?#]/, 1)[0] || undefined;
}

/** Discover candidates without resolving dependencies, reading files or executing project code. */
export function analyzeProjectFiles(files) {
  const result = { entryPages: [], packages: [], buildSystems: [], resources: [], requirements: [], uncertainties: [] };
  const uncertainty = (code, message, at) => result.uncertainties.push({ code, message, location: at });
  const requirement = (feature, at, evidence) => result.requirements.push({ feature, location: at, evidence });
  const resource = (kind, value, at) => {
    const url = safeUrl(value);
    result.resources.push({ kind, ...(url ? { url } : { dynamic: true }), location: at });
    if (!url) uncertainty('resource-unresolved', 'Resource reference could not be safely represented.', at);
    return url;
  };
  const stylesheet = (source, at, context = 'stylesheet', attribute = false) => {
    const tokenLocation = node => {
      const start = node.loc?.start;
      if (attribute || !start) return at;
      return { path: at.path, line: at.line + start.line - 1, column: start.line === 1 ? at.column + start.column - 1 : start.column };
    };
    try {
      const ast = css.parse(source, { context, positions: true, onParseError: () => uncertainty('css-parse-recovery', 'CSS parser recovered a syntax issue.', at) });
      css.walk(ast, node => {
        if (node.type === 'Url') resource('css', node.value, tokenLocation(node));
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import' && node.prelude) {
          const first = node.prelude.children?.first;
          if (first?.type === 'String') resource('css-import', first.value, tokenLocation(first));
        }
      });
    } catch { uncertainty('invalid-css', 'CSS could not be parsed.', at); }
  };
  for (const { path, source } of files) {
    const at = location(path);
    const basename = path.split('/').at(-1);
    if (/^vite\.config\.(?:[cm]?[jt]s)$/.test(basename)) result.buildSystems.push({ name: 'vite', candidate: true, location: at, evidence: 'Configuration filename; configuration was not executed.' });
    if (basename === 'package.json') {
      let manifest;
      try { manifest = JSON.parse(source); } catch { uncertainty('invalid-manifest', 'Package manifest is not valid JSON.', at); continue; }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { uncertainty('invalid-manifest', 'Package manifest must be an object.', at); continue; }
      const dependencies = [...new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(key => names(manifest[key])))].sort();
      const entry = { path, ...(packageName(manifest.name) ? { name: manifest.name } : {}), scripts: names(manifest.scripts), dependencies };
      const range = manifest.dependencies?.three ?? manifest.devDependencies?.three ?? manifest.peerDependencies?.three ?? manifest.optionalDependencies?.three;
      if (typeof range === 'string' && range.length <= 100 && /^[0-9xX*~^<>=|. +\-v]+$/.test(range)) entry.three = range;
      else if (range !== undefined) uncertainty('three-range-omitted', 'Three.js declaration is not a reportable version range.', at);
      const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      if (Array.isArray(workspaces)) entry.workspaces = workspaces.filter(value => typeof value === 'string' && /^[a-z0-9_.*!/@{}?,\-]+$/i.test(value) && !value.includes('://'));
      result.packages.push(entry);
      if (dependencies.includes('vite')) result.buildSystems.push({ name: 'vite', candidate: true, location: at, evidence: 'Declared Vite dependency; configuration was not executed.' });
    }
    if (/\.html?$/i.test(path)) {
      requirement('ui.dom', at, 'HTML document input.');
      const page = { path, scripts: [] }; result.entryPages.push(page);
      const tree = parse(source, { sourceCodeLocationInfo: true, onParseError: error => uncertainty('html-parse-recovery', 'HTML parser recovered a syntax issue.', location(path, error)) });
      const visit = node => {
        const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
        const here = location(path, node.sourceCodeLocation);
        const attrLocation = name => location(path, node.sourceCodeLocation?.attrs?.[name] ?? node.sourceCodeLocation);
        if (node.tagName === 'script') {
          const type = (attrs.type ?? '').trim().toLowerCase();
          if (type === 'importmap') {
            uncertainty('import-map-unresolved', 'Import maps are not analyzed or resolved.', here);
          } else if (attrs.src !== undefined) {
            const src = resource('script', attrs.src, attrLocation('src'));
            page.scripts.push({ kind: type === 'module' ? 'module' : 'classic', ...(src ? { src } : {}), line: here.line, column: here.column });
          } else if (!type || type === 'module' || ['text/javascript', 'application/javascript'].includes(type)) {
            const start = node.sourceCodeLocation?.startTag;
            page.scripts.push({ kind: 'inline', source: (node.childNodes ?? []).map(child => child.value ?? '').join(''), line: start?.endLine ?? here.line, column: start?.endCol ?? here.column });
          }
        }
        if (node.tagName === 'style') {
          const start = node.sourceCodeLocation?.startTag;
          const bodyAt = { path, line: start?.endLine ?? here.line, column: start?.endCol ?? here.column };
          requirement('ui.css', bodyAt, 'Inline HTML stylesheet.');
          const body = start ? source.slice(start.endOffset, node.sourceCodeLocation.endTag?.startOffset ?? node.sourceCodeLocation.endOffset) : '';
          stylesheet(body, bodyAt);
        }
        if (attrs.style !== undefined) {
          const styleAt = attrLocation('style');
          requirement('ui.css', styleAt, 'Inline HTML style declaration.');
          uncertainty('style-attribute-location', 'Decoded style attribute resources use the attribute start; original token positions are not inferred.', styleAt);
          stylesheet(attrs.style, styleAt, 'declarationList', true);
        }
        for (const name of Object.keys(attrs)) {
          if (name.startsWith('on')) uncertainty('inline-handler-unresolved', 'Inline event handler code is not analyzed.', attrLocation(name));
          if (name === 'srcset') uncertainty('srcset-unresolved', 'Responsive source sets are not analyzed or resolved.', attrLocation(name));
        }
        if (node.tagName === 'canvas') requirement('ui.dom', here, 'HTML canvas element.');
        if (node.tagName === 'link' && attrs.href !== undefined) resource('link', attrs.href, attrLocation('href'));
        if (node.tagName !== 'script' && attrs.src !== undefined) resource(node.tagName ?? 'html', attrs.src, attrLocation('src'));
        for (const child of node.childNodes ?? []) visit(child);
        if (node.content) visit(node.content);
      };
      visit(tree);
    }
    if (/\.css$/i.test(path)) {
      requirement('ui.css', at, 'CSS stylesheet input.');
      stylesheet(source, at);
    }
  }
  return result;
}

import { parse } from 'parse5';
import * as css from 'css-tree';

const MAX_HTML_DEPTH = 256;
const MAX_HTML_NODES = 20000;
const MAX_FINDINGS = 10000;
const MAX_LOCK_PACKAGES = 100000;
const npmLockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

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
  const result = { entryPages: [], packages: [], buildSystems: [], resources: [], requirements: [], dependencyResolutions: [], uncertainties: [] };
  let findings = 0, limited = false;
  const append = (array, value) => {
    if (findings++ < MAX_FINDINGS) array.push(value);
    else if (!limited) {
      limited = true;
      result.uncertainties.push({ code: 'ANALYSIS_INCOMPLETE', message: 'Discovery finding limit reached; remaining findings were omitted.', location: value.location ?? location(value.path ?? files[0]?.path) });
    }
  };
  const uncertainty = (code, message, at) => append(result.uncertainties, { code, message, location: at });
  const requirement = (feature, at, evidence) => append(result.requirements, { feature, location: at, evidence });
  const resolveThree = (path, dependencyPath, version) => {
    if (dependencyPath.length > 1024 || !/^(?:[A-Za-z0-9@._-]+\/)*node_modules\/three$/.test(dependencyPath)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(dependencyPath)) {
      uncertainty('npm-three-path-omitted', 'A Three.js lockfile package path is not safely reportable.', location(path));
      return;
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      uncertainty('npm-three-resolution-omitted', 'A locked Three.js version is not a reportable semantic version.', location(path));
      return;
    }
    append(result.dependencyResolutions, { manager: 'npm', lockfile: path, packagePath: dependencyPath, name: 'three', version,
      evidence: 'Version recorded in an npm lockfile; installation and runtime use are unverified.' });
  };
  const npmLock = (path, source) => {
    let lock;
    try { lock = JSON.parse(source.replace(/^\uFEFF/, '')); } catch {
      uncertainty('invalid-lockfile', 'npm lockfile is not valid JSON.', location(path));
      return;
    }
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
      uncertainty('invalid-lockfile', 'npm lockfile must be a JSON object.', location(path));
      return;
    }
    let scanned = 0, truncated = false;
    if (lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages)) {
      for (const [packagePath, record] of Object.entries(lock.packages)) {
        if (++scanned > MAX_LOCK_PACKAGES) { truncated = true; break; }
        if (/(?:^|\/)node_modules\/three$/.test(packagePath)) {
          if (record?.name !== undefined && record.name !== 'three') {
            uncertainty('npm-three-alias-omitted', 'A lockfile path named three identifies a different package name.', location(path));
          } else resolveThree(path, packagePath, record?.version);
        }
      }
    } else if (lock.dependencies && typeof lock.dependencies === 'object' && !Array.isArray(lock.dependencies)) {
      const pending = [{ dependencies: lock.dependencies, parent: '' }];
      while (pending.length) {
        const { dependencies, parent } = pending.pop();
        for (const [name, record] of Object.entries(dependencies)) {
          if (++scanned > MAX_LOCK_PACKAGES) { truncated = true; pending.length = 0; break; }
          const packagePath = `${parent ? `${parent}/` : ''}node_modules/${name}`;
          if (name === 'three') {
            if (record?.name !== undefined && record.name !== 'three') {
              uncertainty('npm-three-alias-omitted', 'A lockfile path named three identifies a different package name.', location(path));
            } else resolveThree(path, packagePath, record?.version);
          }
          if (record?.dependencies && typeof record.dependencies === 'object' && !Array.isArray(record.dependencies)) {
            pending.push({ dependencies: record.dependencies, parent: packagePath });
          }
        }
      }
    } else {
      uncertainty('npm-lock-structure-unknown', 'npm lockfile has no recognized packages or dependencies table.', location(path));
    }
    if (truncated) uncertainty('ANALYSIS_INCOMPLETE', 'npm lockfile package limit reached; remaining resolutions were not inspected.', location(path));
  };
  const resource = (kind, value, at) => {
    const url = safeUrl(value);
    append(result.resources, { kind, ...(url ? { url } : { dynamic: true }), location: at });
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
    if (npmLockfiles.has(basename)) npmLock(path, source);
    if (/^vite\.config\.(?:[cm]?[jt]s)$/.test(basename)) append(result.buildSystems, { name: 'vite', candidate: true, location: at, evidence: 'Configuration filename; configuration was not executed.' });
    if (basename === 'package.json') {
      let manifest;
      try { manifest = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { uncertainty('invalid-manifest', 'Package manifest is not valid JSON.', at); continue; }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { uncertainty('invalid-manifest', 'Package manifest must be an object.', at); continue; }
      const dependencies = [...new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(key => names(manifest[key])))].sort();
      const entry = { path, ...(packageName(manifest.name) ? { name: manifest.name } : {}), scripts: manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts) ? Object.keys(manifest.scripts).filter(name => name.length > 0 && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name)).sort() : [], dependencies };
      if (manifest.scripts !== undefined && (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts) || Object.keys(manifest.scripts).length !== entry.scripts.length)) uncertainty('script-names-omitted', 'Some script names could not be represented; command values are never included.', at);
      const range = manifest.dependencies?.three ?? manifest.devDependencies?.three ?? manifest.peerDependencies?.three ?? manifest.optionalDependencies?.three;
      if (typeof range === 'string' && range.length <= 100 && /^[0-9xX*~^<>=|. +\-v]+$/.test(range)) entry.three = range;
      else if (range !== undefined) uncertainty('three-range-omitted', 'Three.js declaration is not a reportable version range.', at);
      const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      if (Array.isArray(workspaces)) {
        entry.workspaces = workspaces.filter(value => typeof value === 'string' && value.length <= 1024 && /^[a-z0-9_.*!/@{}?, \[\]\-]+$/i.test(value));
        if (entry.workspaces.length !== workspaces.length) uncertainty('workspace-entries-omitted', 'Some workspace declarations could not be represented.', at);
      } else if (manifest.workspaces !== undefined) uncertainty('workspace-entries-omitted', 'Workspace declarations are not a supported array.', at);
      append(result.packages, entry);
      if (dependencies.includes('vite')) append(result.buildSystems, { name: 'vite', candidate: true, location: at, evidence: 'Declared Vite dependency; configuration was not executed.' });
    }
    if (/\.html?$/i.test(path)) {
      requirement('ui.dom', at, 'HTML document input.');
      const page = { path, scripts: [] }; append(result.entryPages, page);
      const tree = parse(source, { sourceCodeLocationInfo: true, onParseError: error => uncertainty('html-parse-recovery', 'HTML parser recovered a syntax issue.', location(path, error)) });
      const pending = [{ node: tree, depth: 0 }];
      let visited = 0, depthLimited = false;
      while (pending.length) {
        const { node, depth } = pending.pop();
        if (++visited > MAX_HTML_NODES) {
          uncertainty('ANALYSIS_INCOMPLETE', 'HTML node limit reached; remaining nodes were not analyzed.', at);
          break;
        }
        if (depth > MAX_HTML_DEPTH) {
          if (!depthLimited) uncertainty('ANALYSIS_INCOMPLETE', 'HTML depth limit reached; deeper nodes were not analyzed.', at);
          depthLimited = true;
          continue;
        }
        const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
        const here = location(path, node.sourceCodeLocation);
        const attrLocation = name => location(path, node.sourceCodeLocation?.attrs?.[name] ?? node.sourceCodeLocation);
        if (node.tagName === 'script') {
          const type = (attrs.type ?? '').trim().toLowerCase();
          if (type === 'importmap') {
            uncertainty('import-map-unresolved', 'Import maps are not analyzed or resolved.', here);
          } else if (attrs.src !== undefined) {
            const src = resource('script', attrs.src, attrLocation('src'));
            append(page.scripts, { kind: type === 'module' ? 'module' : 'classic', ...(src ? { src } : {}), line: here.line, column: here.column });
          } else if (!type || type === 'module' || ['text/javascript', 'application/javascript'].includes(type)) {
            const start = node.sourceCodeLocation?.startTag;
            append(page.scripts, { kind: 'inline', source: (node.childNodes ?? []).map(child => child.value ?? '').join(''), line: start?.endLine ?? here.line, column: start?.endCol ?? here.column });
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
        if (node.content) pending.push({ node: node.content, depth: depth + 1 });
        const children = node.childNodes ?? [];
        const available = Math.max(0, MAX_HTML_NODES - visited - pending.length);
        if (children.length > available) uncertainty('ANALYSIS_INCOMPLETE', 'HTML node limit reached; remaining nodes were not analyzed.', at);
        for (let index = Math.min(children.length, available) - 1; index >= 0; index--) pending.push({ node: children[index], depth: depth + 1 });
      }
    }
    if (/\.css$/i.test(path)) {
      requirement('ui.css', at, 'CSS stylesheet input.');
      stylesheet(source, at);
    }
  }
  return result;
}

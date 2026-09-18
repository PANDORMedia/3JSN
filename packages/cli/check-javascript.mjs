import { parse } from '@babel/parser';
import { extname } from 'node:path';

const globalObjects = new Set(['window', 'self', 'globalThis']);
const wrappers = new Set(['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression',
  'TSSatisfiesExpression', 'TSInstantiationExpression', 'ParenthesizedExpression']);
const globals = new Map([
  ['document', ['ui.dom', 'document reference']],
  ['DOMParser', ['ui.dom', 'DOMParser reference']],
  ['Node', ['ui.dom', 'Node reference']],
  ['Element', ['ui.dom', 'Element reference']],
  ['HTMLElement', ['ui.dom', 'HTMLElement reference']],
  ['requestAnimationFrame', ['runtime.animation-frame', 'requestAnimationFrame reference']],
  ['cancelAnimationFrame', ['runtime.animation-frame', 'cancelAnimationFrame reference']],
  ['Worker', ['runtime.workers', 'Worker reference']],
  ['SharedWorker', ['runtime.workers', 'SharedWorker reference']],
  ['WebAssembly', ['runtime.wasm', 'WebAssembly reference']],
  ['fetch', ['services.fetch', 'fetch reference']],
  ['WebSocket', ['services.websocket', 'WebSocket reference']],
  ['AudioContext', ['services.audio', 'AudioContext reference']],
  ['webkitAudioContext', ['services.audio', 'webkitAudioContext reference']],
  ['OfflineAudioContext', ['services.audio', 'OfflineAudioContext reference']],
  ['AudioWorkletNode', ['services.audio', 'AudioWorkletNode reference']],
  ['RTCPeerConnection', ['services.webrtc', 'RTCPeerConnection reference']],
  ['MediaRecorder', ['services.webrtc', 'MediaRecorder reference']],
  ['localStorage', ['services.storage', 'localStorage reference']],
  ['sessionStorage', ['services.storage', 'sessionStorage reference']],
  ['indexedDB', ['services.storage', 'indexedDB reference']],
  ['caches', ['services.storage', 'CacheStorage reference']],
]);
const rendererFeatures = new Map([
  ['WebGLRenderer', 'graphics.webgl2'], ['WebGPURenderer', 'graphics.webgpu'],
]);
const threeRendererModules = new Map([
  ['three/src/renderers/WebGLRenderer.js', 'WebGLRenderer'],
  ['three/src/renderers/webgpu/WebGPURenderer.js', 'WebGPURenderer'],
  ['three/addons/renderers/webgpu/WebGPURenderer.js', 'WebGPURenderer'],
  ['three/examples/jsm/renderers/webgpu/WebGPURenderer.js', 'WebGPURenderer'],
]);
const threeNamespaceModules = new Set(['three', 'three/webgpu']);
const contextFeatures = new Map([['webgl', 'graphics.webgl1'], ['experimental-webgl', 'graphics.webgl1'],
  ['webgl2', 'graphics.webgl2'], ['webgpu', 'graphics.webgpu'], ['2d', 'graphics.canvas2d']]);

function unwrap(node) {
  while (node && wrappers.has(node.type)) node = node.expression;
  return node;
}
function literal(node) {
  node = unwrap(node);
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}
function property(node) {
  if (!['MemberExpression', 'OptionalMemberExpression'].includes(node?.type)) return undefined;
  return node.computed ? literal(node.property) : node.property.type === 'Identifier' ? node.property.name : undefined;
}
function chain(node) {
  node = unwrap(node);
  const result = [];
  while (['MemberExpression', 'OptionalMemberExpression'].includes(node?.type)) {
    const name = property(node);
    if (name === undefined) return undefined;
    result.unshift(name);
    node = unwrap(node.object);
  }
  if (node?.type !== 'Identifier') return undefined;
  result.unshift(node.name);
  if (globalObjects.has(result[0]) && result.length > 1) result.shift();
  return result;
}
function importMetaUrl(node) {
  node = unwrap(node);
  return property(node) === 'url' && node.object.type === 'MetaProperty'
    && node.object.meta.name === 'import' && node.object.property.name === 'meta';
}
function staticUrl(node) {
  node = unwrap(node);
  if (literal(node) !== undefined) return literal(node);
  if (node?.type === 'NewExpression' && chain(node.callee)?.join('.') === 'URL'
    && importMetaUrl(node.arguments[1])) return literal(node.arguments[0]);
  return undefined;
}

// Visit runtime expressions, including default parameter values, without treating
// binding names, object keys, JSX names or TypeScript type names as API references.
function* nodes(ast) {
  const stack = [{ node: ast, parent: null, key: '', binding: false }];
  while (stack.length) {
    const item = stack.pop(), { node, binding } = item;
    yield item;
    let keys;
    if (wrappers.has(node.type)) keys = ['expression'];
    else if (node.type === 'TSEnumDeclaration') keys = ['members'];
    else if (node.type === 'TSEnumMember') keys = ['initializer'];
    else if (node.type === 'TSModuleDeclaration') keys = ['body'];
    else if (node.type === 'TSModuleBlock') keys = ['body'];
    else if (node.type.startsWith('TS') || node.type === 'ImportDeclaration'
      || node.type === 'ExportSpecifier' || node.type === 'ExportNamespaceSpecifier') keys = [];
    else keys = Object.keys(node).filter(key => !['loc', 'extra', 'comments', 'leadingComments', 'trailingComments',
      'innerComments', 'tokens', 'errors', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType',
      'superTypeParameters', 'superTypeArguments', 'implements'].includes(key));
    for (const key of keys.reverse()) {
      const value = node[key], children = Array.isArray(value) ? value : [value];
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (!child || typeof child !== 'object' || typeof child.type !== 'string') continue;
        let childBinding = binding;
        if ((node.type === 'VariableDeclarator' && key === 'id')
          || (key === 'params') || (key === 'id' && /Function|Class/.test(node.type))
          || (node.type === 'CatchClause' && key === 'param')) childBinding = true;
        if ((node.type === 'AssignmentPattern' && key === 'right') || (key === 'key' && node.computed)) childBinding = false;
        stack.push({ node: child, parent: node, key, binding: childBinding });
      }
    }
  }
}
function reference({ node, parent, key, binding }) {
  if (binding || node.type !== 'Identifier') return false;
  if (key === 'key' && !parent.computed) return false;
  if (key === 'property' && !parent.computed) return false;
  if (key === 'label' || parent?.type === 'MetaProperty' || parent?.type === 'PrivateName') return false;
  return true;
}
function threeBindings(ast) {
  const bindings = new Map();
  const imported = (source, name) => threeNamespaceModules.has(source)
    ? rendererFeatures.has(name) ? name : undefined
    : name === 'default' ? threeRendererModules.get(source) : undefined;
  for (const { node } of nodes(ast)) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const specifier of node.specifiers) {
        if (specifier.importKind === 'type') continue;
        const name = specifier.type === 'ImportNamespaceSpecifier' ? '*'
          : specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.name ?? specifier.imported.value;
        const renderer = imported(node.source.value, name);
        if (renderer) bindings.set(specifier.local.name, renderer);
        else if (name === '*' && threeNamespaceModules.has(node.source.value)) bindings.set(specifier.local.name, '*');
      }
    }
    if (node.type === 'VariableDeclarator') {
      const init = unwrap(node.init);
      if (init?.type !== 'CallExpression' || chain(init.callee)?.join('.') !== 'require') continue;
      const source = literal(init.arguments[0]);
      if (node.id.type === 'Identifier' && threeNamespaceModules.has(source)) bindings.set(node.id.name, '*');
      else if (node.id.type === 'ObjectPattern') {
        for (const member of node.id.properties) {
          if (member.type !== 'ObjectProperty' || member.computed || member.value.type !== 'Identifier') continue;
          const renderer = imported(source, member.key.name ?? member.key.value);
          if (renderer) bindings.set(member.value.name, renderer);
        }
      }
    }
  }
  return bindings;
}

/** Read-only syntactic inventory, not reachability or runtime compatibility proof.
 * Imported aliases are recognized without lexical binding/reassignment analysis.
 * Columns are one-based UTF-16 positions; startColumn is a zero-based offset on
 * the first input line (for inline HTML scripts). URL suffixes and remote URLs
 * never appear in returned evidence, assets or module specifiers.
 */
export function analyzeJavaScript(source, path, { startLine = 1, startColumn = 0 } = {}) {
  if (typeof source !== 'string' || typeof path !== 'string'
    || !Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(startColumn) || startColumn < 0) {
    throw new TypeError('Expected source/path strings and valid source-location offsets.');
  }
  const result = { requirements: [], imports: [], assets: [], uncertainties: [] };
  const location = node => {
    const start = node?.loc?.start ?? node?.loc ?? { line: 1, column: 0 };
    return { path, line: start.line + startLine - 1, column: start.column + (start.line === 1 ? startColumn : 0) + 1 };
  };
  const seen = new Set();
  function uncertainty(code, message, node) {
    const entry = { code, message, location: location(node) }, key = JSON.stringify(entry);
    if (!seen.has(key)) { seen.add(key); result.uncertainties.push(entry); }
  }
  let ast;
  try {
    const extension = extname(path).toLowerCase();
    const plugins = [];
    if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) plugins.push('typescript');
    if (['.jsx', '.tsx', '.js', '.mjs', '.cjs'].includes(extension)) plugins.push('jsx');
    ast = parse(source, { sourceType: 'unambiguous', plugins, createImportExpressions: true,
      attachComment: false, allowReturnOutsideFunction: extension === '.cjs' || extension === '.cts' });
  } catch (error) {
    uncertainty('JAVASCRIPT_PARSE_ERROR', 'The source could not be parsed; its dependencies and API candidates remain unresolved.', error);
    return result;
  }
  const aliases = threeBindings(ast);
  let bindingWarning = false;
  function requirement(feature, evidence, node) {
    const entry = { feature, location: location(node), evidence: `Syntactic candidate: ${evidence}.` };
    const key = JSON.stringify(entry);
    if (!seen.has(key)) { seen.add(key); result.requirements.push(entry); }
    if (!bindingWarning) {
      uncertainty('JAVASCRIPT_BINDINGS_UNVERIFIED', 'Syntactic API names and imported aliases may be shadowed or reassigned; runtime use and reachability are unverified.', node);
      bindingWarning = true;
    }
  }
  function safeReference(value, node) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\')) {
      uncertainty('JAVASCRIPT_REFERENCE_OMITTED', 'A reference with unsupported path characters was omitted.', node);
      return undefined;
    }
    if (value.startsWith('//') || (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^node:[a-z\d_./-]+$/iu.test(value))) {
      uncertainty('JAVASCRIPT_EXTERNAL_REFERENCE', 'A remote or scheme-based reference was omitted; it requires explicit external-resource analysis.', node);
      return undefined;
    }
    const cleaned = value.split(/[?#]/u)[0];
    if (cleaned !== value) uncertainty('JAVASCRIPT_REFERENCE_SUFFIX', 'A URL query or fragment was omitted; resolution of the original reference is unverified.', node);
    if (!cleaned) {
      uncertainty('JAVASCRIPT_REFERENCE_OMITTED', 'An empty or suffix-only reference needs origin and resolution analysis.', node);
      return undefined;
    }
    if (cleaned && !cleaned.startsWith('.') && !cleaned.startsWith('/')
      && !/^(?:node:)?[a-z\d_@][a-z\d_@./~-]*$/iu.test(cleaned)) {
      uncertainty('JAVASCRIPT_REFERENCE_OMITTED', 'A reference outside safe local or package-name syntax was omitted.', node);
      return undefined;
    }
    return cleaned;
  }
  function moduleImport(kind, value, node, dynamic) {
    const specifier = safeReference(value, node);
    result.imports.push({ kind, ...(specifier === undefined ? {} : { specifier }), location: location(node), dynamic });
    if (dynamic) uncertainty('JAVASCRIPT_DYNAMIC_IMPORT', 'Runtime module loading needs reachability and resolution analysis, including when its argument is a literal.', node);
  }
  function asset(kind, expression, node) {
    const value = staticUrl(expression), url = safeReference(value, node), dynamic = value === undefined;
    result.assets.push({ kind, ...(url === undefined ? {} : { url }), dynamic, location: location(node) });
    if (dynamic) uncertainty('JAVASCRIPT_DYNAMIC_ASSET', 'The resource expression cannot be resolved by this bounded syntactic analysis.', node);
  }
  for (const item of nodes(ast)) {
    const { node } = item;
    if (node.type === 'ImportDeclaration') {
      const typeOnly = node.importKind === 'type' || (node.specifiers.length > 0 && node.specifiers.every(s => s.importKind === 'type'));
      moduleImport(typeOnly ? 'import-type' : 'import', node.source.value, node, false);
    } else if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      moduleImport(node.exportKind === 'type' ? 'export-type' : 'export', node.source.value, node, false);
    } else if (node.type === 'ImportExpression') {
      moduleImport('dynamic-import', literal(node.source), node, true);
    } else if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference.type === 'TSExternalModuleReference') {
      moduleImport(node.importKind === 'type' ? 'import-type' : 'require', literal(node.moduleReference.expression), node, false);
    }
    if (reference(item)) {
      if (node.name === 'eval' || node.name === 'Function') uncertainty('JAVASCRIPT_DYNAMIC_CODE',
        'A dynamic-code API reference prevents a complete static dependency or capability inventory.', node);
      const finding = globals.get(node.name);
      if (finding) requirement(...finding, node);
      const renderer = aliases.get(node.name);
      if (rendererFeatures.has(renderer)) requirement(rendererFeatures.get(renderer),
        `imported Three.js ${renderer} reference (Three.js version and renderer behavior unverified)`, node);
    }
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
      if (node.computed) uncertainty('JAVASCRIPT_COMPUTED_ACCESS', 'Computed property access requires binding and runtime validation; arbitrary property values are not evaluated.', node);
      const parts = chain(node);
      if (parts?.length === 1 && ['eval', 'Function'].includes(parts[0])) uncertainty('JAVASCRIPT_DYNAMIC_CODE',
        'A dynamic-code API reference prevents a complete static dependency or capability inventory.', node);
      if (parts?.length === 1 && globals.has(parts[0])) requirement(...globals.get(parts[0]), node);
      if (parts?.join('.') === 'navigator.gpu') requirement('graphics.webgpu', 'navigator.gpu access', node);
      if (parts?.join('.') === 'navigator.mediaDevices') requirement('services.webrtc', 'navigator.mediaDevices access', node);
      if (parts?.join('.') === 'navigator.getGamepads') requirement('input.gamepad', 'navigator.getGamepads access', node);
      if (property(node) === 'audioWorklet') requirement('services.audio', 'audioWorklet member access (receiver unverified)', node);
      if (parts?.length === 2 && aliases.get(parts[0]) === '*' && rendererFeatures.has(parts[1])) {
        requirement(rendererFeatures.get(parts[1]), `imported Three.js ${parts[1]} namespace member (Three.js version and renderer behavior unverified)`, node);
      }
    }
    if (!['CallExpression', 'OptionalCallExpression', 'NewExpression'].includes(node.type)) continue;
    const name = chain(node.callee)?.join('.'), member = property(unwrap(node.callee));
    if (name === 'require') moduleImport('require', literal(node.arguments[0]), node, literal(node.arguments[0]) === undefined);
    if (['setTimeout', 'setInterval'].includes(name) && literal(node.arguments[0]) !== undefined) {
      uncertainty('JAVASCRIPT_DYNAMIC_CODE', 'Dynamic code evaluation prevents a complete static dependency or capability inventory.', node);
    }
    if (member === 'getContext') {
      const context = literal(node.arguments[0]);
      const feature = contextFeatures.get(context);
      if (feature) requirement(feature, `${context} getContext call (receiver unverified)`, node);
      else uncertainty('JAVASCRIPT_CONTEXT_UNRESOLVED', 'A getContext argument is dynamic or outside the recognized context types.', node);
    }
    if (node.type === 'NewExpression' && ['Worker', 'SharedWorker'].includes(name)) asset(name === 'Worker' ? 'worker' : 'shared-worker', node.arguments[0], node);
    if (name === 'fetch') asset('fetch', node.arguments[0], node);
    if (node.type === 'NewExpression' && name === 'WebSocket') asset('websocket', node.arguments[0], node);
    if (member === 'addModule' && property(unwrap(node.callee).object) === 'audioWorklet') asset('audio-worklet', node.arguments[0], node);
    if (node.type === 'NewExpression' && name === 'URL' && importMetaUrl(node.arguments[1])) asset('url', node.arguments[0], node);
  }
  for (const values of Object.values(result)) values.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
  return result;
}

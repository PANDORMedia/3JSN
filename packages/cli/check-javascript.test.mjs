import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeJavaScript } from './check-javascript.mjs';

const analyze = (source, path = 'src/app.js', options) => analyzeJavaScript(source, path, options);
const features = result => new Set(result.requirements.map(item => item.feature));
const codes = result => new Set(result.uncertainties.map(item => item.code));
const withoutLocation = entries => entries.map(({ location, ...entry }) => entry);

test('recognizes named Three.js aliases, namespaces and known renderer entry modules', () => {
  const result = analyze(`import { WebGLRenderer as Legacy } from 'three';
import * as Engine from 'three/webgpu';
import GPU from 'three/src/renderers/webgpu/WebGPURenderer.js';
new Legacy(); new Engine.WebGPURenderer(); new GPU();`);
  assert.deepEqual(features(result), new Set(['graphics.webgl2', 'graphics.webgpu']));
  assert.equal(result.requirements.length, 3);
  assert(result.requirements.every(item => item.evidence.startsWith('Syntactic candidate: imported Three.js')));
  assert(result.requirements.every(item => item.evidence.includes('version') && item.evidence.includes('unverified')));
  assert(codes(result).has('JAVASCRIPT_BINDINGS_UNVERIFIED'));
  assert.deepEqual(result.imports.map(item => item.specifier), ['three', 'three/webgpu', 'three/src/renderers/webgpu/WebGPURenderer.js']);
});

test('recognizes bounded CommonJS Three.js namespace and destructured aliases', () => {
  const result = analyze(`const T = require('three');
const { WebGPURenderer: GPU } = require('three/webgpu');
new T.WebGLRenderer(); new GPU();`, 'app.cjs');
  assert.deepEqual(features(result), new Set(['graphics.webgl2', 'graphics.webgpu']));
  assert.deepEqual(withoutLocation(result.imports), [
    { kind: 'require', specifier: 'three', dynamic: false },
    { kind: 'require', specifier: 'three/webgpu', dynamic: false },
  ]);
});

test('does not classify comments, strings, declaration names or ordinary static property keys as API use', () => {
  const result = analyze(`// new Worker('fake.js'); fetch('https://secret.invalid');
/* document.body; import 'fake'; new THREE.WebGLRenderer(); */
const text = "WebAssembly WebSocket localStorage new AudioContext()";
const names = { fetch: 1, Worker: 2, document: 3 };
function fetch(document, WebSocket) { return 1; }
class Worker { document() {} }
const template = \`new SharedWorker('fake')\`;`);
  assert.deepEqual(result, { requirements: [], imports: [], assets: [], uncertainties: [] });
});

test('separates WebGL1, WebGL2, WebGPU, Canvas2D and dynamic getContext syntax', () => {
  const result = analyze(`canvas.getContext('webgl'); canvas.getContext('experimental-webgl');
canvas.getContext('webgl2'); canvas.getContext('webgpu'); canvas.getContext('2d');
canvas.getContext(selected); canvas['getContext']('2d');`);
  assert.deepEqual(features(result), new Set(['graphics.webgl1', 'graphics.webgl2', 'graphics.webgpu', 'graphics.canvas2d']));
  assert(codes(result).has('JAVASCRIPT_CONTEXT_UNRESOLVED'));
  assert(codes(result).has('JAVASCRIPT_COMPUTED_ACCESS'));
  assert(result.requirements.every(item => item.evidence.includes('receiver unverified')));
});

test('inventories the requested browser API families through direct and global-object syntax', () => {
  const result = analyze(`document.createElement('canvas'); globalThis.requestAnimationFrame(tick);
new Worker('./worker.js'); new self.SharedWorker('./shared.js');
WebAssembly.instantiate(bytes); window.fetch('/resource.bin');
new WebSocket('wss://example.invalid/socket'); new AudioContext();
context.audioWorklet.addModule('./processor.js'); new AudioWorkletNode(context, 'processor');
new RTCPeerConnection(); navigator.mediaDevices.getUserMedia({audio:true});
localStorage.getItem('key'); self.indexedDB.open('db'); navigator.getGamepads(); navigator.gpu.requestAdapter();`);
  assert.deepEqual(features(result), new Set(['ui.dom', 'runtime.animation-frame', 'runtime.workers', 'runtime.wasm',
    'services.fetch', 'services.websocket', 'services.audio', 'services.webrtc', 'services.storage', 'input.gamepad', 'graphics.webgpu']));
  assert(result.assets.some(item => item.kind === 'audio-worklet' && item.url === './processor.js'));
  assert(result.assets.some(item => item.kind === 'shared-worker' && item.url === './shared.js'));
});

test('static import/export discovery remains distinct from runtime import and require expressions', () => {
  const result = analyze(`import thing from './one.js';
export {thing} from '@scope/pkg/feature'; export * from './all.js';
require('./legacy.cjs'); import('./lazy.js'); import(prefix + name); require(variable);`);
  assert.deepEqual(withoutLocation(result.imports), [
    { kind: 'import', specifier: './one.js', dynamic: false },
    { kind: 'export', specifier: '@scope/pkg/feature', dynamic: false },
    { kind: 'export', specifier: './all.js', dynamic: false },
    { kind: 'require', specifier: './legacy.cjs', dynamic: false },
    { kind: 'dynamic-import', specifier: './lazy.js', dynamic: true },
    { kind: 'dynamic-import', dynamic: true },
    { kind: 'require', dynamic: true },
  ]);
  assert.equal(result.uncertainties.filter(item => item.code === 'JAVASCRIPT_DYNAMIC_IMPORT').length, 3);
});

test('worker and import.meta URL assets distinguish literal URLs from unresolved expressions', () => {
  const result = analyze(`new Worker(new URL('./workers/a.mjs', import.meta.url), {type:'module'});
new URL(\`./textures/floor.png\`, import.meta.url);
new Worker(new URL(workerName, import.meta.url));
fetch(urlFromConfiguration);`);
  assert.deepEqual(withoutLocation(result.assets), [
    { kind: 'worker', url: './workers/a.mjs', dynamic: false },
    { kind: 'url', url: './workers/a.mjs', dynamic: false },
    { kind: 'url', url: './textures/floor.png', dynamic: false },
    { kind: 'worker', dynamic: true },
    { kind: 'url', dynamic: true },
    { kind: 'fetch', dynamic: true },
  ]);
  assert.equal(result.uncertainties.filter(item => item.code === 'JAVASCRIPT_DYNAMIC_ASSET').length, 3);
});

test('TSX expressions are inventoried without treating type names or JSX text as runtime use', () => {
  const result = analyze(`import type { Worker, WebSocket } from './types';
export type { Other } from './other';
type Shape = { document: Worker; fetch: WebSocket; };
const component: Shape | null = null;
const view = <button onClick={() => fetch('/api')}>document WebAssembly</button>;
const element = document.createElement('div') as HTMLElement;`, 'screen.tsx');
  assert.deepEqual(features(result), new Set(['services.fetch', 'ui.dom']));
  assert.deepEqual(withoutLocation(result.imports), [
    { kind: 'import-type', specifier: './types', dynamic: false },
    { kind: 'export-type', specifier: './other', dynamic: false },
  ]);
  assert(!codes(result).has('JAVASCRIPT_PARSE_ERROR'));
});

test('TS assertions, TS require imports and runtime enum initializers retain executable expressions', () => {
  const result = analyze(`import tools = require('./tools.cjs');
const a = <HTMLElement>document.body;
const b = (navigator.gpu!) satisfies unknown;
enum Values { item = fetch('/enum-value') as any }`, 'app.ts');
  assert.deepEqual(features(result), new Set(['ui.dom', 'graphics.webgpu', 'services.fetch']));
  assert.deepEqual(withoutLocation(result.imports), [{ kind: 'require', specifier: './tools.cjs', dynamic: false }]);
});

test('JSX extension and JavaScript default-parameter runtime expressions are supported', () => {
  const result = analyze(`const view = <div>Worker fetch document</div>;
function create(document = globalThis.document, fetch = window.fetch('/default')) { return 1; }`, 'view.jsx');
  assert.deepEqual(features(result), new Set(['ui.dom', 'services.fetch']));
  assert.equal(result.requirements.length, 2);
});

test('locations are one-based UTF-16 with first-line-only HTML script column offsets', () => {
  const result = analyze("fetch('/a');\r\n  document.body;\nconst emoji='😀'; fetch('/b');", 'page.html', { startLine: 12, startColumn: 8 });
  assert.deepEqual(result.requirements.map(item => item.location), [
    { path: 'page.html', line: 12, column: 9 },
    { path: 'page.html', line: 13, column: 3 },
    { path: 'page.html', line: 14, column: 19 },
  ]);
});

test('malformed source returns a generic located uncertainty without parser token/source leakage', () => {
  const result = analyze("const x = ; // PRIVATE_SOURCE_TOKEN\nfetch('https://user:SECRET@host.invalid?AUTH=SECRET');", 'broken.ts', { startLine: 7, startColumn: 4 });
  assert.deepEqual(result.requirements, []); assert.deepEqual(result.imports, []); assert.deepEqual(result.assets, []);
  assert.deepEqual(result.uncertainties, [{ code: 'JAVASCRIPT_PARSE_ERROR',
    message: 'The source could not be parsed; its dependencies and API candidates remain unresolved.',
    location: { path: 'broken.ts', line: 7, column: 15 } }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE_TOKEN|SECRET|host\.invalid/);
});

test('dynamic import, computed access, indirect eval and function constructors remain explicit uncertainties', () => {
  const result = analyze(`import('./literal.js'); window[feature](payload); window['fetch']('/safe');
(0, eval)(program); globalThis.eval(program); new Function('PRIVATE_CODE');
setTimeout('PRIVATE_CODE', 1);`);
  for (const code of ['JAVASCRIPT_DYNAMIC_IMPORT', 'JAVASCRIPT_COMPUTED_ACCESS', 'JAVASCRIPT_DYNAMIC_CODE']) {
    assert(codes(result).has(code), code);
  }
  assert(features(result).has('services.fetch'));
  assert.equal(result.uncertainties.filter(item => item.code === 'JAVASCRIPT_DYNAMIC_CODE').length, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CODE/);
});

test('credentials, remote URLs, source strings and URL suffixes are absent from all output fields', () => {
  const result = analyze(`import remote from 'https://alice:SECRET@host.invalid/app.js?TOKEN=SECRET#SECRET';
export * from '//alice:SECRET@host.invalid/module.js';
import('./local.js?TOKEN=SECRET#SECRET');
new Worker('blob:https://host.invalid/SECRET');
new URL('data:application/javascript,SECRET', import.meta.url);
fetch('/api/state?TOKEN=SECRET#SECRET');
new WebSocket('wss://alice:SECRET@host.invalid/socket?TOKEN=SECRET');
require('node:fs'); import 'safe-package/subpath'; import './file with spaces.js';`);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SECRET|TOKEN|alice|host\.invalid|https:|wss:|blob:|data:/);
  assert.deepEqual(result.imports.map(item => item.specifier), [undefined, undefined, './local.js', 'node:fs', 'safe-package/subpath', './file with spaces.js']);
  assert(result.assets.some(item => item.kind === 'fetch' && item.url === '/api/state'));
  assert(codes(result).has('JAVASCRIPT_EXTERNAL_REFERENCE'));
  assert(codes(result).has('JAVASCRIPT_REFERENCE_SUFFIX'));
});

test('escaped URL schemes, backslashes and control characters cannot bypass reference redaction', () => {
  const result = analyze(String.raw`import remote from 'h\u0074tps://u:SECRET@host.invalid/x';
new Worker('\\\\host.invalid\\SECRET');
fetch('/\\host.invalid/SECRET');
fetch('//user:SECRET@host.invalid');
fetch('\\\\user:SECRET@host.invalid');
fetch('/\\user:SECRET@host.invalid');
import('./a\nSECRET.js');`);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|host\.invalid/);
  assert(result.imports.every(item => item.specifier === undefined));
  assert(result.assets.every(item => item.url === undefined));
});

test('empty or suffix-only references are explicitly unresolved without leaking their suffix', () => {
  const result = analyze("fetch(''); import('?SECRET'); new URL('#SECRET', import.meta.url);");
  assert(codes(result).has('JAVASCRIPT_REFERENCE_OMITTED'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert(result.assets.every(item => item.url === undefined));
  assert(result.imports.every(item => item.specifier === undefined));
});

test('shadowing and reassignment are not silently presented as proven global or renderer requirements', () => {
  const result = analyze(`function local(fetch) { fetch('/local'); }
import {WebGPURenderer as Renderer} from 'three/webgpu';
function shadow(Renderer) { return new Renderer(); }`);
  assert.deepEqual(features(result), new Set(['services.fetch', 'graphics.webgpu']));
  assert(result.requirements.every(item => item.evidence.startsWith('Syntactic candidate:')));
  assert(result.uncertainties.some(item => item.code === 'JAVASCRIPT_BINDINGS_UNVERIFIED' && item.message.includes('shadowed or reassigned')));
});

test('analysis executes no source or imports and leaves its inputs unchanged', () => {
  const source = `globalThis.__checkJavascriptExecuted = true; require('missing-private-package'); throw new Error('DO_NOT_EXECUTE');`;
  const result = analyze(source);
  assert.equal(globalThis.__checkJavascriptExecuted, undefined);
  assert.equal(result.imports[0].specifier, 'missing-private-package');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXECUTE/);
});

test('invalid API arguments fail generically instead of leaking caller text', () => {
  for (const options of [{ startLine: 0 }, { startLine: 1.5 }, { startColumn: -1 }]) {
    assert.throws(() => analyze('PRIVATE', 'path.js', options), error => error instanceof TypeError && !error.message.includes('PRIVATE'));
  }
});

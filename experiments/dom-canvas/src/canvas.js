import { core } from 'ext:core/mod.js';
import { HTMLElement, Document, idOf, registerElementClass, observeAttributes } from 'ext:html_v8_probe/bindings.js';

core.registerErrorBuilder('DOMExceptionInvalidStateError', message => new DOMException(message, 'InvalidStateError'));
const contexts = new WeakMap();
const backends = new Map();

// Host initialization installs backends; one canvas retains its first successful
// mode. Callbacks receive the real DOM wrapper and must commit resize state only
// after native success. This registry does not install application globals.
export function registerCanvasBackend(name, backend) {
  if (typeof name !== 'string' || !name || typeof backend?.create !== 'function'
    || typeof backend?.resize !== 'function') {
    throw new TypeError('Expected a canvas backend name, create and resize callbacks');
  }
  if (backends.has(name)) throw new TypeError(`Canvas backend already registered: ${name}`);
  backends.set(name, Object.freeze({ create: backend.create, resize: backend.resize }));
}

registerCanvasBackend('webgpu', {
  create: (canvas, width, height) => core.ops.op_canvas_context(idOf(canvas), canvas, width, height),
  resize: (canvas, _context, width, height) => core.ops.op_canvas_resize(idOf(canvas), width, height),
});
function dimension(canvas, name, fallback) {
  const match = /^[\t\n\f\r ]*\+?(\d+)/.exec(canvas.getAttribute(name) ?? '');
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value <= 0xffffffff ? value : fallback;
}
class HTMLCanvasElement extends HTMLElement {
  get width() { return dimension(this, 'width', 300); }
  set width(value) { this.setAttribute('width', String(+value >>> 0)); }
  get height() { return dimension(this, 'height', 150); }
  set height(value) { this.setAttribute('height', String(+value >>> 0)); }
  getContext(kind) {
    const node = core.ops.op_dom_read({ kind: 'describe', id: idOf(this) });
    if (node.nodeType !== 1 || node.localName !== 'canvas' || node.namespace !== 'http://www.w3.org/1999/xhtml') {
      throw new TypeError('Expected an HTML canvas node');
    }
    kind = '' + kind;
    const existing = contexts.get(this);
    if (existing) return existing.kind === kind ? existing.context : null;
    const backend = backends.get(kind);
    if (!backend) return null;
    const context = backend.create(this, this.width, this.height);
    if (context === null) return null;
    if (typeof context !== 'object' && typeof context !== 'function') {
      throw new TypeError('Canvas backend must return a context object or null');
    }
    contexts.set(this, { kind, context });
    observeAttributes(this, name => {
      if (name === 'width' || name === 'height') backend.resize(this, context, this.width, this.height);
    });
    return context;
  }
}
registerElementClass('canvas', HTMLCanvasElement);
globalThis.HTMLCanvasElement = HTMLCanvasElement;
Document.prototype.createElementNS = function(namespace, tag) {
  if (namespace !== 'http://www.w3.org/1999/xhtml') throw new DOMException('Only HTML elements are supported by this probe', 'NotSupportedError');
  return this.createElement(tag);
};

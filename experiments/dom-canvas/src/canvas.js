import { core } from 'ext:core/mod.js';
import { HTMLElement, Document, idOf, registerElementClass, observeAttributes } from 'ext:html_v8_probe/bindings.js';

core.registerErrorBuilder('DOMExceptionInvalidStateError', message => new DOMException(message, 'InvalidStateError'));
const contexts = new WeakMap();
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
    const id = idOf(this);
    if ('' + kind !== 'webgpu') return null;
    if (!contexts.has(this)) {
      const context = core.ops.op_canvas_context(id, this, this.width, this.height);
      contexts.set(this, context);
      observeAttributes(this, name => {
        if (name === 'width' || name === 'height') core.ops.op_canvas_resize(id, this.width, this.height);
      });
    }
    return contexts.get(this);
  }
}
registerElementClass('canvas', HTMLCanvasElement);
globalThis.HTMLCanvasElement = HTMLCanvasElement;
Document.prototype.createElementNS = function(namespace, tag) {
  if (namespace !== 'http://www.w3.org/1999/xhtml') throw new DOMException('Only HTML elements are supported by this probe', 'NotSupportedError');
  return this.createElement(tag);
};

import { core } from 'ext:core/mod.js';

const { op_dom_read: read, op_dom_mutate: mutate, op_observe: observe } = core.ops;
const ids = new WeakMap();
const wrappers = new Map();
const classLists = new WeakMap();
const styles = new WeakMap();
const constructionKey = Symbol('native-node');
const nativeEventTarget = EventTarget.prototype;

function idOf(node) {
  const id = ids.get(node);
  if (id === undefined) throw new TypeError('Expected a node from this document');
  return id;
}
function wrap(id) {
  if (id === null) return null;
  if (wrappers.has(id)) return wrappers.get(id);
  const { tag } = read({ kind: 'describe', id });
  const Type = tag === '#document' ? Document : tag === 'input' ? HTMLInputElement : HTMLElement;
  const node = new Type(constructionKey, id);
  wrappers.set(id, node);
  return node;
}

class Node extends EventTarget {
  constructor(key, id) {
    super();
    if (key !== constructionKey) throw new TypeError('Illegal constructor');
    ids.set(this, id);
  }
  get nodeType() {
    const { tag } = read({ kind: 'describe', id: idOf(this) });
    return tag === '#document' ? 9 : tag === '#text' ? 3 : 1;
  }
  get parentNode() {
    // Rust's DOM path excludes anonymous layout boxes, which are not DOM parents.
    return wrap(read({ kind: 'path', id: idOf(this) })[1] ?? null);
  }
  getRootNode() {
    const path = read({ kind: 'path', id: idOf(this) });
    return wrap(path[path.length - 1]);
  }
  get textContent() { return read({ kind: 'text', id: idOf(this) }); }
  set textContent(value) { mutate({ kind: 'text', id: idOf(this), value: String(value ?? '') }); }
  appendChild(child) { return wrap(mutate({ kind: 'append', id: idOf(this), child: idOf(child) })); }
  removeChild(child) { return wrap(mutate({ kind: 'remove', id: idOf(this), child: idOf(child) })); }
  dispatchEvent(event) {
    const type = event.type;
    const inert = () => {};
    // deno_web 0.290 skips its dispatch algorithm when the target has no listener
    // for this type. A temporary listener preserves ancestor-only propagation
    // and cancelled-event results while Deno owns all event state and dispatch.
    nativeEventTarget.addEventListener.call(this, type, inert);
    try {
      return nativeEventTarget.dispatchEvent.call(this, event);
    } finally {
      nativeEventTarget.removeEventListener.call(this, type, inert);
    }
  }
}

class Element extends Node {
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  getAttribute(name) { return read({ kind: 'attribute', id: idOf(this), name: String(name) }); }
  setAttribute(name, value) { mutate({ kind: 'attribute', id: idOf(this), name: String(name), value: String(value) }); }
  querySelector(selector) { return wrap(read({ kind: 'query', id: idOf(this), selector: String(selector), all: false })); }
  querySelectorAll(selector) { return read({ kind: 'query', id: idOf(this), selector: String(selector), all: true }).map(wrap); }
  set innerHTML(value) { mutate({ kind: 'html', id: idOf(this), value: String(value) }); }
  getBoundingClientRect() { return read({ kind: 'rect', id: idOf(this) }); }
  get classList() {
    if (!classLists.has(this)) {
      const tokens = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      const validate = values => values.map(value => {
        const token = String(value);
        if (!token || /\s/.test(token)) throw new TypeError('Invalid class token');
        return token;
      });
      classLists.set(this, {
        add: (...values) => this.setAttribute('class', [...new Set([...tokens(), ...validate(values)])].join(' ')),
        remove: (...values) => { const removed = validate(values); this.setAttribute('class', tokens().filter(token => !removed.includes(token)).join(' ')); },
        contains: value => tokens().includes(String(value)),
      });
    }
    return classLists.get(this);
  }
  get style() {
    if (!styles.has(this)) {
      styles.set(this, new Proxy({}, {
        set: (_, name, value) => {
          mutate({ kind: 'style', id: idOf(this), name: String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value: String(value) });
          return true;
        },
      }));
    }
    return styles.get(this);
  }
}
class HTMLElement extends Element {
  click() { this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
}
class HTMLInputElement extends HTMLElement {}
class Document extends Node {
  createElement(tag) { return wrap(mutate({ kind: 'create', tag: String(tag).toLowerCase() })); }
  getElementById(id) { return wrap(read({ kind: 'findById', value: String(id) })); }
  querySelector(selector) { return wrap(read({ kind: 'query', id: idOf(this), selector: String(selector), all: false })); }
  querySelectorAll(selector) { return read({ kind: 'query', id: idOf(this), selector: String(selector), all: true }).map(wrap); }
  get body() { return this.querySelector('body'); }
}

let nextFrameId = 0;
const frames = new Map();
function requestAnimationFrame(callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected animation callback');
  frames.set(++nextFrameId, callback);
  return nextFrameId;
}
function cancelAnimationFrame(id) { frames.delete(id); }
function advanceFrame(timestamp) {
  for (const id of [...frames.keys()]) {
    const callback = frames.get(id);
    if (!callback) continue;
    frames.delete(id);
    callback(timestamp);
  }
}
Object.assign(globalThis, {
  Node, Element, HTMLElement, HTMLInputElement, Document,
  document: wrap(read({ kind: 'describe', id: null }).id),
  requestAnimationFrame, cancelAnimationFrame,
  __advanceProbeFrame: advanceFrame,
  __blitz_send_message: observe,
});

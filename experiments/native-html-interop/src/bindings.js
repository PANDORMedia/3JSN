import { core } from 'ext:core/mod.js';
import { createFocusController } from 'ext:html_v8_probe/focus.js';

const { op_dom_read: read, op_dom_mutate: nativeMutate, op_observe: observe } = core.ops;
const ids = new WeakMap();
const wrappers = new Map();
const classLists = new WeakMap();
const styles = new WeakMap();
const constructionKey = Symbol('native-node');
const nativeEventTarget = EventTarget.prototype;
const elementClasses = new Map();
const attributeObservers = new WeakMap();
const childLists = new WeakMap();
const elementLists = new WeakMap();
for (const name of ['HierarchyRequestError', 'NotFoundError']) {
  core.registerErrorBuilder(`DOMException${name}`, message => new DOMException(message, name));
}

export function registerElementClass(tag, Type) { elementClasses.set(tag, Type); }
export function observeAttributes(node, callback) { attributeObservers.set(node, callback); }
export { HTMLElement, Document, idOf };
export const focusController = createFocusController({
  read, mutate: nativeMutate, idOf, wrap, document: () => document,
  emit(target, type, relatedTarget, bubbles) {
    const event = new Event(type, { bubbles, composed: true });
    for (const [name, value] of Object.entries({ relatedTarget, view: globalThis, detail: 0 })) {
      Object.defineProperty(event, name, { value, enumerable: true });
    }
    target.dispatchEvent(event);
  },
});
const mutate = request => focusController.mutate(request);

function idOf(node) {
  const id = ids.get(node);
  if (id === undefined) throw new TypeError('Expected a node from this document');
  return id;
}
export function wrap(id) {
  if (id === null) return null;
  if (wrappers.has(id)) return wrappers.get(id);
  const { tag, nodeType } = read({ kind: 'describe', id });
  const Type = ({ 9: Document, 3: Text, 8: Comment }[nodeType])
    ?? elementClasses.get(tag) ?? (tag === 'input' ? HTMLInputElement : tag === 'iframe' ? HTMLIFrameElement : HTMLElement);
  const node = new Type(constructionKey, id);
  wrappers.set(id, node);
  return node;
}

const collectionReaders = new WeakMap();
function collectionValues(collection) {
  const readValues = collectionReaders.get(collection);
  if (!readValues) throw new TypeError('Illegal invocation');
  return readValues();
}
function namedElement(values, name) {
  return name === '' ? null : values.find(child => child.id === name || child.getAttribute('name') === name) ?? null;
}
class LiveCollection {
  constructor(key, node, elements = false) {
    if (key !== constructionKey) throw new TypeError('Illegal constructor');
    const values = () => read({ kind: 'describe', id: idOf(node) }).children.map(wrap).filter(child => !elements || child.nodeType === 1);
    const indexed = name => typeof name === 'string' && /^(0|[1-9]\d*)$/.test(name);
    const names = () => elements ? [...new Set(values().flatMap(child => [child.id, child.getAttribute('name')])
      .filter(name => name && !indexed(name) && !Reflect.has(this, name)))] : [];
    const descriptor = name => {
      const value = indexed(name) ? values()[Number(name)]
        : elements && typeof name === 'string' && !Reflect.has(this, name) ? namedElement(values(), name) ?? undefined : undefined;
      return value === undefined ? undefined : { value, writable: false, enumerable: indexed(name), configurable: true };
    };
    const proxy = new Proxy(this, {
      get: (target, name, receiver) => descriptor(name)?.value ?? Reflect.get(target, name, receiver),
      has: (target, name) => Boolean(descriptor(name)) || Reflect.has(target, name),
      ownKeys: target => [...new Set([...values().keys()].map(String).concat(names(), Reflect.ownKeys(target)))],
      getOwnPropertyDescriptor: (target, name) => descriptor(name) ?? Reflect.getOwnPropertyDescriptor(target, name),
      set: (target, name, value) => indexed(name) || descriptor(name) ? false : Reflect.set(target, name, value),
      defineProperty: (target, name, value) => indexed(name) || descriptor(name) ? false : Reflect.defineProperty(target, name, value),
      deleteProperty: (target, name) => descriptor(name) ? false : Reflect.deleteProperty(target, name),
      preventExtensions: () => false,
    });
    collectionReaders.set(this, values);
    collectionReaders.set(proxy, values);
    return proxy;
  }
  get length() { return collectionValues(this).length; }
  item(index) { return collectionValues(this)[Number(index) >>> 0] ?? null; }
  *[Symbol.iterator]() {
    for (let index = 0; index < this.length; index++) yield this[index];
  }
}
class NodeList extends LiveCollection {
  constructor(key, node) { super(key, node); }
  get [Symbol.toStringTag]() { return 'NodeList'; }
  values() { return this[Symbol.iterator](); }
  *keys() { for (let index = 0; index < this.length; index++) yield index; }
  *entries() { for (let index = 0; index < this.length; index++) yield [index, this[index]]; }
  forEach(callback, receiver) {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const length = this.length;
    for (let index = 0; index < length; index++) {
      if (index in this) callback.call(receiver, this[index], index, this);
    }
  }
}
class HTMLCollection extends LiveCollection {
  constructor(key, node) { super(key, node, true); }
  get [Symbol.toStringTag]() { return 'HTMLCollection'; }
  namedItem(name) { return namedElement(collectionValues(this), String(name)); }
}
function elementChildren(node) {
  if (!elementLists.has(node)) elementLists.set(node, new HTMLCollection(constructionKey, node));
  return elementLists.get(node);
}

class Node extends EventTarget {
  constructor(key, id) {
    super();
    if (key !== constructionKey) throw new TypeError('Illegal constructor');
    ids.set(this, id);
  }
  get nodeType() {
    return read({ kind: 'describe', id: idOf(this) }).nodeType;
  }
  get nodeName() { return read({ kind: 'describe', id: idOf(this) }).nodeName; }
  get ownerDocument() { return this.nodeType === 9 ? null : document; }
  get childNodes() {
    if (!childLists.has(this)) childLists.set(this, new NodeList(constructionKey, this));
    return childLists.get(this);
  }
  get firstChild() { return this.childNodes.item(0); }
  get lastChild() { return this.childNodes.item(this.childNodes.length - 1); }
  get previousSibling() { return wrap(read({ kind: 'describe', id: idOf(this) }).previousSibling); }
  get nextSibling() { return wrap(read({ kind: 'describe', id: idOf(this) }).nextSibling); }
  get parentElement() { const parent = this.parentNode; return parent instanceof Element ? parent : null; }
  get isConnected() { return this.getRootNode().nodeType === 9; }
  get nodeValue() { return null; }
  set nodeValue(_) {}
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
  insertBefore(child, before) { return wrap(mutate({ kind: 'insert', id: idOf(this), child: idOf(child), before: before == null ? null : idOf(before) })); }
  removeChild(child) { return wrap(mutate({ kind: 'remove', id: idOf(this), child: idOf(child) })); }
  contains(other) { return other != null && read({ kind: 'path', id: idOf(other) }).includes(idOf(this)); }
  hasChildNodes() { return this.childNodes.length !== 0; }
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

class CharacterData extends Node {
  get data() { return read({ kind: 'text', id: idOf(this) }); }
  set data(value) { mutate({ kind: 'characterData', id: idOf(this), value: value === null ? '' : String(value) }); }
  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = value ?? ''; }
  get length() { return this.data.length; }
}
class Text extends CharacterData {}
class Comment extends CharacterData {}

for (const [name, value] of Object.entries({ ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 })) {
  Object.defineProperty(Node, name, { value, enumerable: true });
  Object.defineProperty(Node.prototype, name, { value, enumerable: true });
}

class Element extends Node {
  get children() { return elementChildren(this); }
  get tagName() { return this.nodeName; }
  get namespaceURI() { return read({ kind: 'describe', id: idOf(this) }).namespace; }
  get localName() { return read({ kind: 'describe', id: idOf(this) }).localName; }
  get prefix() { return read({ kind: 'describe', id: idOf(this) }).prefix; }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  getAttribute(name) { return read({ kind: 'attribute', id: idOf(this), name: String(name) }); }
  setAttribute(name, value) {
    name = String(name);
    const canonicalName = mutate({ kind: 'attribute', id: idOf(this), name, value: String(value) });
    attributeObservers.get(this)?.(canonicalName);
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    name = String(name);
    const canonicalName = mutate({ kind: 'removeAttribute', id: idOf(this), name });
    attributeObservers.get(this)?.(canonicalName);
  }
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
      const property = name => name === 'cssFloat' ? 'float' : String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^ms-/, '-ms-');
      const getPropertyValue = name => read({ kind: 'style', id: idOf(this), name: String(name) });
      const setProperty = (name, value, priority = '') => {
        value = value === null ? '' : String(value);
        priority = String(priority ?? '').toLowerCase();
        if (value !== '' && priority !== '' && priority !== 'important') return;
        mutate({ kind: 'style', id: idOf(this), name: String(name), value, important: priority === 'important' });
      };
      const methods = { getPropertyValue, setProperty, removeProperty(name) {
        const previous = getPropertyValue(name); setProperty(name, ''); return previous;
      } };
      styles.set(this, new Proxy(methods, {
        get: (target, name) => {
          if (Object.hasOwn(target, name)) return target[name];
          if (name === 'cssText') return read({ kind: 'style', id: idOf(this), name: null });
          return typeof name === 'string' ? getPropertyValue(property(name)) : Reflect.get(target, name);
        },
        set: (_, name, value) => {
          if (name === 'cssText') mutate({ kind: 'styleText', id: idOf(this), value: String(value ?? '') });
          else setProperty(property(name), value);
          return true;
        },
      }));
    }
    return styles.get(this);
  }
}
class HTMLElement extends Element {
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get tabIndex() { return read({ kind: 'focusability', id: idOf(this) }).tabIndex; }
  set tabIndex(value) { this.setAttribute('tabindex', String(+value | 0)); }
  focus() { focusController.focus(this); }
  blur() { focusController.blur(this); }
  click() { this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
}
class HTMLInputElement extends HTMLElement {}
class HTMLIFrameElement extends HTMLElement {}
class Document extends Node {
  get children() { return elementChildren(this); }
  createElement(tag) { return wrap(mutate({ kind: 'create', tag: String(tag).toLowerCase() })); }
  createTextNode(value) { return wrap(mutate({ kind: 'createText', value: String(value) })); }
  getElementById(id) { return wrap(read({ kind: 'findById', value: String(id) })); }
  querySelector(selector) { return wrap(read({ kind: 'query', id: idOf(this), selector: String(selector), all: false })); }
  querySelectorAll(selector) { return read({ kind: 'query', id: idOf(this), selector: String(selector), all: true }).map(wrap); }
  get body() { return this.querySelector('body'); }
  get head() { return this.querySelector('head'); }
  get documentElement() { return this.children.item(0); }
  get defaultView() { return globalThis; }
  get activeElement() { return focusController.activeElement(); }
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
  Node, NodeList, HTMLCollection, Element, HTMLElement, HTMLInputElement, HTMLIFrameElement, CharacterData, Text, Comment, Document,
  window: globalThis, self: globalThis,
  document: wrap(read({ kind: 'describe', id: null }).id),
  requestAnimationFrame, cancelAnimationFrame,
  __advanceProbeFrame: advanceFrame,
  __blitz_send_message: observe,
});

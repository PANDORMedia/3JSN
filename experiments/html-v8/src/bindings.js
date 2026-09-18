import { core } from 'ext:core/mod.js';

for (const name of ['HierarchyRequestError', 'NotFoundError']) {
  core.registerErrorBuilder(`DOMException${name}`, message => Object.assign(new Error(message), { name }));
}

const { op_dom_read: read, op_dom_mutate: mutate, op_observe: observe } = core.ops;
const ids = new WeakMap();
const wrappers = new Map();
const listeners = new WeakMap();
const classLists = new WeakMap();
const styles = new WeakMap();
const eventStates = new WeakMap();
const constructionKey = Symbol('native-node');

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
function optionsOf(options) {
  return typeof options === 'boolean' ? { capture: options } : (options ?? {});
}
function invoke(node, event, capture, phase) {
  const state = eventStates.get(event);
  state.currentTarget = node;
  state.eventPhase = phase;
  const registered = listeners.get(node) ?? [];
  for (const listener of [...registered]) {
    if (state.immediate) break;
    if (listener.type !== event.type || listener.capture !== capture || !registered.includes(listener)) continue;
    if (listener.once) registered.splice(registered.indexOf(listener), 1);
    state.passive = listener.passive;
    try {
      if (typeof listener.callback === 'function') listener.callback.call(node, event);
      else listener.callback.handleEvent(event);
    } finally {
      state.passive = false;
    }
  }
}

class Event {
  constructor(type, options = {}) {
    this.type = String(type);
    this.bubbles = Boolean(options.bubbles);
    this.cancelable = Boolean(options.cancelable);
    eventStates.set(this, { target: null, currentTarget: null, eventPhase: 0,
      stopped: false, immediate: false, cancelled: false, passive: false, dispatching: false });
  }
  get target() { return eventStates.get(this).target; }
  get currentTarget() { return eventStates.get(this).currentTarget; }
  get eventPhase() { return eventStates.get(this).eventPhase; }
  get defaultPrevented() { return eventStates.get(this).cancelled; }
  preventDefault() {
    const state = eventStates.get(this);
    if (this.cancelable && !state.passive) state.cancelled = true;
  }
  stopPropagation() { eventStates.get(this).stopped = true; }
  stopImmediatePropagation() {
    const state = eventStates.get(this);
    state.stopped = state.immediate = true;
  }
}

class Node {
  constructor(key, id) {
    if (key !== constructionKey) throw new TypeError('Illegal constructor');
    ids.set(this, id);
  }
  get parentNode() { return wrap(read({ kind: 'describe', id: idOf(this) }).parent); }
  get textContent() { return read({ kind: 'text', id: idOf(this) }); }
  set textContent(value) { mutate({ kind: 'text', id: idOf(this), value: String(value ?? '') }); }
  appendChild(child) { return wrap(mutate({ kind: 'append', id: idOf(this), child: idOf(child) })); }
  removeChild(child) { return wrap(mutate({ kind: 'remove', id: idOf(this), child: idOf(child) })); }
  addEventListener(type, callback, options) {
    if (callback === null || callback === undefined) return;
    const { capture = false, once = false, passive = false } = optionsOf(options);
    const registered = listeners.get(this) ?? [];
    if (!registered.some(listener => listener.type === String(type) && listener.callback === callback && listener.capture === Boolean(capture))) {
      registered.push({ type: String(type), callback, capture: Boolean(capture), once: Boolean(once), passive: Boolean(passive) });
    }
    listeners.set(this, registered);
  }
  removeEventListener(type, callback, options) {
    const registered = listeners.get(this) ?? [];
    const index = registered.findIndex(listener => listener.type === String(type) && listener.callback === callback && listener.capture === Boolean(optionsOf(options).capture));
    if (index >= 0) registered.splice(index, 1);
  }
  dispatchEvent(event) {
    const state = eventStates.get(event);
    if (!state || state.dispatching) throw new TypeError('Invalid event dispatch');
    // The propagation path comes from Rust once; listener mutations cannot rewrite it.
    const path = read({ kind: 'path', id: idOf(this) }).map(wrap);
    state.target = this;
    state.dispatching = true;
    try {
      for (let index = path.length - 1; index > 0 && !state.stopped; index--) invoke(path[index], event, true, 1);
      if (!state.stopped) {
        invoke(this, event, true, 2);
        if (!state.immediate) invoke(this, event, false, 2);
      }
      if (event.bubbles) {
        for (let index = 1; index < path.length && !state.stopped; index++) invoke(path[index], event, false, 3);
      }
      return !state.cancelled;
    } finally {
      state.currentTarget = null;
      state.eventPhase = 0;
      state.dispatching = state.stopped = state.immediate = false;
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
  getElementById(id) {
    return wrap(read({ kind: 'findById', value: String(id) }));
  }
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
  Node, Element, HTMLElement, HTMLInputElement, Document, Event,
  document: wrap(read({ kind: 'describe', id: null }).id),
  requestAnimationFrame, cancelAnimationFrame,
  __advanceProbeFrame: advanceFrame,
  __blitz_send_message: observe,
});

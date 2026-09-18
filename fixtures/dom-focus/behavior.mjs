// SPDX-License-Identifier: MIT
// Focus timing and reentrancy are observations, not assumed cross-engine rules.
const focusTypes = ['blur', 'focusout', 'focus', 'focusin'];
const task = () => new Promise(resolve => setTimeout(resolve, 0));
const label = node => node === null ? null : node === document ? '#document'
  : node === globalThis ? '#window' : node.id || node.nodeName.toLowerCase();

function state() {
  return {
    activeElement: label(document.activeElement),
    focus: label(document.querySelector(':focus')),
    focusWithin: Array.from(document.querySelectorAll(':focus-within'), label),
  };
}

function element(tag, id, text, parent) {
  const node = document.createElement(tag);
  node.setAttribute('id', id);
  node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

export async function runFocusBehavior() {
  if (typeof document.body?.focus !== 'function' || typeof document.body?.blur !== 'function') {
    throw new Error('This fixture requires HTMLElement.focus(), HTMLElement.blur() and Document.activeElement');
  }
  const initial = state();
  const stage = element('div', 'focus-stage', '', document.body);
  const left = element('div', 'focus-left', '', stage);
  const right = element('div', 'focus-right', '', stage);
  const a = element('button', 'focus-a', 'A', left);
  const b = element('button', 'focus-b', 'B', right);
  const c = element('button', 'focus-c', 'C', right);
  const plain = element('div', 'focus-plain', 'Plain div', stage);
  const negative = element('div', 'focus-negative', 'Programmatic only', stage);
  const zero = element('div', 'focus-zero', 'Sequential zero', stage);
  const positive = element('div', 'focus-positive', 'Sequential positive', stage);
  negative.setAttribute('tabindex', '-1');
  zero.setAttribute('tabindex', '0');
  positive.setAttribute('tabindex', '2');
  const nodes = [a, b, c, plain, negative, zero, positive];
  const cases = [];
  const eventInterfaces = [];
  const listeners = [];
  let hooks = [];
  let current = null;
  const listen = (node, type, handler, capture = false) => {
    node.addEventListener(type, handler, capture);
    listeners.push(() => node.removeEventListener(type, handler, capture));
  };
  function record(listener, expectedCurrentTarget) {
    return event => {
      if (!current) return;
      if (event.currentTarget !== expectedCurrentTarget) throw new Error('Focus event currentTarget changed wrapper identity');
      const eventInterface = { type: event.type, constructor: event.constructor?.name ?? null,
        focusEvent: typeof FocusEvent === 'function' && event instanceof FocusEvent,
        isTrusted: event.isTrusted };
      if (!eventInterfaces.some(value => JSON.stringify(value) === JSON.stringify(eventInterface))) eventInterfaces.push(eventInterface);
      current.events.push({
        type: event.type, listener, phase: event.eventPhase,
        target: label(event.target), relatedTarget: label(event.relatedTarget ?? null),
        boundary: current.boundary, targetConnected: event.target.isConnected,
        targetParent: label(event.target.parentNode),
        activeElement: label(document.activeElement),
        bubbles: event.bubbles, cancelable: event.cancelable,
      });
    };
  }
  for (const type of focusTypes) {
    listen(document, type, record('document-capture', document), true);
    listen(document, type, record('document-bubble', document));
    for (const node of nodes) listen(node, type, record('target', node));
  }
  function hook(node, type, target) {
    const handler = () => {
      current.actions.push({ at: type, from: label(node), focus: label(target), before: label(document.activeElement) });
      target.focus();
      current.actions.push({ returnedFrom: type, activeElement: label(document.activeElement) });
    };
    node.addEventListener(type, handler, { once: true });
    hooks.push(() => node.removeEventListener(type, handler));
  }
  async function reset() {
    current = null;
    for (const remove of hooks) remove();
    hooks = [];
    document.activeElement?.blur();
    for (const node of [a, left]) {
      for (const name of ['disabled', 'hidden', 'inert']) node.removeAttribute(name);
      for (const name of ['display', 'visibility', 'opacity']) node.style.setProperty(name, '');
    }
    if (a.parentNode !== left) left.appendChild(a);
    stage.getBoundingClientRect();
    await task();
  }
  async function run(name, setup, action) {
    await reset();
    setup();
    stage.getBoundingClientRect();
    await task();
    current = { name, before: state(), events: [], actions: [], boundary: 'action' };
    action();
    current.actions.push({ boundary: 'action-returned', eventCount: current.events.length,
      activeElement: label(document.activeElement) });
    current.boundary = 'immediate-read';
    current.immediate = state();
    current.boundary = 'microtask';
    await Promise.resolve();
    current.afterMicrotask = state();
    // Record the flush boundary explicitly: hidden-style fixup can be deferred.
    current.boundary = 'layout';
    stage.getBoundingClientRect();
    current.afterLayout = state();
    current.actions.push({ boundary: 'layout-returned', eventCount: current.events.length,
      activeElement: label(document.activeElement) });
    current.boundary = 'post-layout-microtask';
    await Promise.resolve();
    current.afterLayoutMicrotask = state();
    current.boundary = 'task';
    await task();
    current.afterTask = state();
    delete current.boundary;
    cases.push(current);
    current = null;
  }
  try {
    await run('focus-a', () => {}, () => a.focus());
    await run('focus-a-prevent-scroll', () => {}, () => a.focus({ preventScroll: true }));
    await run('focus-b-from-a', () => a.focus(), () => b.focus());
    await run('focus-a-again', () => a.focus(), () => a.focus());
    await run('blur-a', () => a.focus(), () => a.blur());
    await run('blur-unfocused-b', () => a.focus(), () => b.blur());
    await run('focus-body-default', () => a.focus(), () => document.body.focus());
    await run('focus-plain-div', () => a.focus(), () => plain.focus());
    for (const [name, target] of [['negative', negative], ['zero', zero], ['positive', positive]]) {
      await run(`focus-tabindex-${name}`, () => a.focus(), () => target.focus());
    }
    for (const [name, attribute] of [
      ['absent', null], ['empty', ''], ['whitespace', ' \t '], ['plus', ' +2 '], ['minus', ' -1 '],
      ['malformed', 'abc'], ['trailing-text', '2tail'], ['positive-limit', '2147483647'],
      ['positive-overflow', '2147483648'], ['negative-limit', '-2147483648'], ['negative-overflow', '-2147483649'],
    ]) {
      await run(`tabindex-parse-${name}`, () => {
        if (attribute === null) plain.removeAttribute('tabindex');
        else plain.setAttribute('tabindex', attribute);
        a.focus();
      }, () => plain.focus());
      cases[cases.length - 1].tabIndex = { attribute,
        reflected: typeof plain.tabIndex === 'number' ? plain.tabIndex : null, valueType: typeof plain.tabIndex };
    }
    plain.removeAttribute('tabindex');
    await run('focus-detached', () => { left.removeChild(a); b.focus(); }, () => a.focus());
    for (const [name, node, attribute] of [
      ['disabled', a, 'disabled'], ['inert-self', a, 'inert'], ['inert-ancestor', left, 'inert'],
      ['hidden-self', a, 'hidden'], ['hidden-ancestor', left, 'hidden'],
    ]) {
      await run(`focus-${name}`, () => { node.setAttribute(attribute, ''); b.focus(); }, () => a.focus());
    }
    for (const [name, node, property, value] of [
      ['display-none-self', a, 'display', 'none'], ['display-none-ancestor', left, 'display', 'none'],
      ['visibility-hidden-self', a, 'visibility', 'hidden'], ['visibility-hidden-ancestor', left, 'visibility', 'hidden'],
      ['opacity-zero', a, 'opacity', '0'],
    ]) {
      await run(`focus-${name}`, () => { node.style.setProperty(property, value); b.focus(); }, () => a.focus());
    }
    await run('focus-hidden-display-override', () => {
      a.setAttribute('hidden', ''); a.style.setProperty('display', 'block'); b.focus();
    }, () => a.focus());
    for (const [name, action] of [
      ['remove', () => left.removeChild(a)], ['reparent-connected', () => right.appendChild(a)],
      ['disable', () => a.setAttribute('disabled', '')], ['hidden', () => a.setAttribute('hidden', '')],
      ['display-none', () => a.style.setProperty('display', 'none')],
      ['visibility-hidden', () => a.style.setProperty('visibility', 'hidden')],
      ['inert-ancestor', () => left.setAttribute('inert', '')],
    ]) {
      await run(`focused-${name}`, () => a.focus(), action);
    }
    await run('reentrant-blur-focus-c', () => { a.focus(); hook(a, 'blur', c); }, () => b.focus());
    await run('reentrant-focus-focus-c', () => { a.focus(); hook(b, 'focus', c); }, () => b.focus());
    await run('reentrant-focusout-focus-c', () => { a.focus(); hook(a, 'focusout', c); }, () => b.focus());
    for (const name of ['focus-a', 'focus-a-prevent-scroll', 'focus-b-from-a']) {
      const observed = cases.find(value => value.name === name).afterTask;
      if (observed.focus !== observed.activeElement || !observed.focusWithin.includes('focus-stage')
        || !observed.focusWithin.includes(observed.activeElement)) {
        throw new Error(`${name}: focus pseudo-classes must follow the focused element and its ancestors`);
      }
    }
    return { schemaVersion: 1, initial, cases, eventInterfaces, limits: [
      'Programmatic HTML focus only; no physical input, native hit testing, shadow DOM, forms, selection or IME.',
      'preventScroll is passed on a visible node; scrolling behavior is not measured.',
      'Eligibility and event timing are observations, not assumed browser/native equivalence.',
      'Sequential keyboard navigation requires a separate trusted-Tab browser observation.',
      'Event interface and isTrusted observations are separate from semantic state/order; no native FocusEvent claim is implied.',
    ] };
  } finally {
    current = null;
    for (const remove of hooks) remove();
    for (const remove of listeners) remove();
    if (stage.parentNode) stage.parentNode.removeChild(stage);
  }
}

// Separate controls for a browser harness that sends trusted Tab through CDP.
// Synthetic KeyboardEvent dispatch is not treated as a navigation default action.
export function prepareSequentialFocus() {
  const stage = element('div', 'focus-sequential-stage', '', document.body);
  const nodes = [
    element('button', 'sequential-a', 'A', stage),
    element('div', 'sequential-negative', '-1', stage),
    element('div', 'sequential-zero', '0', stage),
    element('button', 'sequential-b', 'B', stage),
  ];
  nodes[1].setAttribute('tabindex', '-1');
  nodes[2].setAttribute('tabindex', '0');
  nodes[0].focus();
  return {
    snapshot: state,
    focusNegative: () => { nodes[1].focus(); return state(); },
    focusFirst: () => { nodes[0].focus(); return state(); },
    dispose: () => { if (stage.parentNode) stage.parentNode.removeChild(stage); },
  };
}

globalThis.focusProbe = { run: runFocusBehavior, prepareSequential: prepareSequentialFocus };

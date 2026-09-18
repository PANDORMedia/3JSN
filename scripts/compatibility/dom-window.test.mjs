import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

test('DOM-window bootstrap connects standard globals to the bounded host protocol', async t => {
  const names = ['window', 'self', 'innerWidth', 'innerHeight', 'devicePixelRatio',
    'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'dispatchEvent', 'document'];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const globalTarget = new EventTarget();
  const node = new EventTarget();
  const otherNode = new EventTarget();
  const globalEvents = [];
  const pending = [];
  const errors = [];
  const microtasks = [];
  const wrapped = [];
  let clock = 10;
  let callbacks;
  let bindings = 0;
  let focused;
  let enableFocus = false;
  const pointerFocus = [];
  const navigation = [];
  const key = Symbol.for('3jsn.dom-window.bootstrap-test');
  const harness = {
    focusController: {
      activeElement: () => focused,
      pointer(target) { pointerFocus.push(target); if (enableFocus && target.eligible) focused = target; },
      navigate(backward) { navigation.push(backward); focused = backward ? node : otherNode; },
    },
    core: {
      ops: {
        op_dom_window_viewport: () => [960, 640, 2],
        op_dom_window_pending: value => pending.push(value),
        op_dom_window_bind: (...values) => { callbacks = values; bindings++; },
      },
      runMicrotasks() { while (microtasks.length) microtasks.shift()(); },
      reportUnhandledException(error) { errors.push(error); },
    },
    wrap(id) {
      wrapped.push(id);
      if (id === '17') return node;
      if (id === '23') return otherNode;
      throw new TypeError('Unknown DOM node');
    },
  };
  globalThis[key] = harness;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { body: globalThis } },
    performance: { configurable: true, value: { now: () => clock } },
    dispatchEvent: { configurable: true, value: event => {
      globalEvents.push(event);
      return globalTarget.dispatchEvent(event);
    } },
  });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'ext:dom_window/animation.js') return {
        shortCircuit: true, url: new URL('../../crates/runtime/src/animation.js', import.meta.url).href,
      };
      if (['ext:core/mod.js', 'ext:html_v8_probe/bindings.js'].includes(specifier)) return {
        shortCircuit: true, url: `dom-window-test:${specifier}`,
      };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('dom-window-test:')) {
        const access = 'globalThis[Symbol.for("3jsn.dom-window.bootstrap-test")]';
        return { shortCircuit: true, format: 'module', source: url.endsWith('core/mod.js')
          ? `export const core = ${access}.core;`
          : `export const wrap = id => ${access}.wrap(id); export const focusController = ${access}.focusController;` };
      }
      return next(url, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    delete globalThis[key];
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await import('../../experiments/dom-canvas/src/window.js');
  const [frame, resize, input] = callbacks;

  await t.test('initialization binds once and exposes CSS viewport getters', () => {
    assert.equal(bindings, 1);
    assert.equal(window, globalThis);
    assert.equal(self, globalThis);
    assert.deepEqual([innerWidth, innerHeight, devicePixelRatio], [480, 320, 2]);
    assert.throws(() => { globalThis.innerWidth = 1; }, TypeError);
    assert.throws(() => requestAnimationFrame(null), TypeError);
  });

  await t.test('resize listeners observe the new dimensions before their microtasks run', () => {
    const seen = [];
    globalTarget.addEventListener('resize', event => {
      seen.push([innerWidth, innerHeight, devicePixelRatio, event.bubbles]);
      microtasks.push(() => seen.push('microtask'));
    }, { once: true });
    resize(1200, 750, 1.5);
    assert.deepEqual(seen, [[800, 500, 1.5, false], 'microtask']);
  });

  await t.test('pointer events use wrapped DOM targets, readonly coordinates and chord state', () => {
    const events = [];
    for (const kind of ['mousedown', 'mouseup', 'mousemove', 'click']) node.addEventListener(kind, event => events.push(event));
    input('mousedown', 20.5, 40.25, 0, '', '17');
    assert.equal(events[0].target, node);
    assert.equal(events[0].clientX, 20.5);
    assert.equal(events[0].clientY, 40.25);
    assert.equal(events[0].button, 0);
    assert.equal(events[0].buttons, 1);
    assert.equal(events[0].bubbles, true);
    assert.equal(events[0].cancelable, true);
    assert.throws(() => { events[0].clientX = 100; }, TypeError);
    input('mousedown', 22, 42, 2, '', '17');
    assert.equal(events.at(-1).buttons, 3);
    input('mousemove', 30, 50, -1, '', '17');
    assert.equal(events.at(-1).button, 0);
    assert.equal(events.at(-1).buttons, 3);
    input('mouseup', 30, 50, 0, '', '17');
    assert.equal(events.at(-1).buttons, 2);
    assert.equal(events.at(-1).type, 'click');
    assert.equal(events.at(-1).detail, 1);
    input('mouseup', 30, 50, 2, '', '17');
    assert.equal(events.at(-1).buttons, 0);
    assert.equal(events.at(-1).type, 'mouseup');
    assert.ok(wrapped.every(id => id === '17'));
    input('mousedown', 4, 8, 0, '', '');
    input('mouseup', 4, 8, 0, '', '');
    assert.equal(globalEvents.at(-1).type, 'click');
  });

  await t.test('only a matching primary release produces exactly one click on its pressed target', () => {
    const clicks = [];
    const first = event => clicks.push(['first', event.button, event.clientX]);
    const second = event => clicks.push(['second', event.button, event.clientX]);
    node.addEventListener('click', first);
    otherNode.addEventListener('click', second);
    try {
      input('mousedown', 10, 10, 0, '', '17');
      input('mouseup', 20, 10, 0, '', '23');
      assert.deepEqual(clicks, []);
      input('mouseup', 10, 10, 0, '', '17');
      assert.deepEqual(clicks, []);
      input('mousedown', 30, 10, 0, '', '23');
      input('mouseup', 32, 10, 0, '', '23');
      assert.deepEqual(clicks, [['second', 0, 32]]);
      input('mouseup', 32, 10, 0, '', '23');
      assert.equal(clicks.length, 1);
      input('mousedown', 10, 10, 0, '', '17');
      input('mouseup', 10, 10, 2, '', '17');
      assert.equal(clicks.length, 1);
      input('mouseup', 12, 10, 0, '', '17');
      assert.deepEqual(clicks.at(-1), ['first', 0, 12]);
      input('mousedown', 10, 10, 2, '', '17');
      input('mouseup', 10, 10, 2, '', '17');
      assert.equal(clicks.length, 2);
    } finally {
      node.removeEventListener('click', first);
      otherNode.removeEventListener('click', second);
    }
  });

  await t.test('pointer reset emits nothing and clears chord state and pending click activation', () => {
    const events = [];
    const record = event => events.push(event);
    for (const kind of ['mousedown', 'mouseup', 'mousemove', 'click']) node.addEventListener(kind, record);
    try {
      input('mousedown', 10, 10, 0, '', '17');
      input('mousedown', 10, 10, 2, '', '17');
      const before = events.length;
      const beforeGlobal = globalEvents.length;
      input('pointerreset', 0, 0, 0, '', '');
      assert.equal(events.length, before);
      assert.equal(globalEvents.length, beforeGlobal);
      input('mousemove', 12, 12, -1, '', '17');
      assert.equal(events.at(-1).buttons, 0);
      input('mouseup', 12, 12, 0, '', '17');
      input('mouseup', 12, 12, 2, '', '17');
      assert.equal(events.filter(event => event.type === 'click').length, 0);
      input('mousedown', 12, 12, 0, '', '17');
      input('mouseup', 12, 12, 0, '', '17');
      assert.equal(events.filter(event => event.type === 'click').length, 1);
      input('mousedown', 12, 12, 0, '', '17');
      input('blur', 0, 0, 0, '', '');
      input('mouseup', 12, 12, 0, '', '17');
      assert.equal(events.filter(event => event.type === 'click').length, 1);
    } finally {
      for (const kind of ['mousedown', 'mouseup', 'mousemove', 'click']) node.removeEventListener(kind, record);
    }
  });

  await t.test('Space/R preserve key values, infer repeats, and release state on keyup or blur', () => {
    input('keydown', 0, 0, 0, ' ', '');
    const initial = globalEvents.at(-1);
    assert.deepEqual([initial.key, initial.code, initial.repeat], [' ', 'Space', false]);
    assert.throws(() => { initial.key = 'r'; }, TypeError);
    input('keydown', 0, 0, 0, ' ', '');
    assert.equal(globalEvents.at(-1).repeat, true);
    input('keyup', 0, 0, 0, ' ', '');
    assert.equal(globalEvents.at(-1).repeat, false);
    input('keydown', 0, 0, 0, 'Space', '');
    assert.equal(globalEvents.at(-1).repeat, false);
    assert.equal(globalEvents.at(-1).key, ' ');
    input('keydown', 0, 0, 0, 'R', '');
    assert.deepEqual([globalEvents.at(-1).key, globalEvents.at(-1).code, globalEvents.at(-1).repeat], ['R', 'KeyR', false]);
    input('keydown', 0, 0, 0, 'r', '');
    assert.equal(globalEvents.at(-1).repeat, true);
    input('mousedown', 10, 10, 0, '', '17');
    input('blur', 0, 0, 0, '', '');
    assert.equal(globalEvents.at(-1).type, 'blur');
    input('focus', 0, 0, 0, '', '');
    assert.equal(globalEvents.at(-1).type, 'focus');
    input('keydown', 0, 0, 0, 'r', '');
    assert.equal(globalEvents.at(-1).repeat, false);
    input('mousemove', 10, 10, -1, '', '');
    assert.equal(globalEvents.at(-1).buttons, 0);
  });

  await t.test('keyboard routing re-reads focus, carries native fields and honors canceled Tab', () => {
    const events = [];
    focused = node;
    const down = event => { events.push(['down', event.target, event.code, event.repeat, event.shiftKey, event.ctrlKey, event.altKey, event.metaKey]); focused = otherNode; };
    const up = event => events.push(['up', event.target]);
    node.addEventListener('keydown', down, { once: true });
    otherNode.addEventListener('keyup', up, { once: true });
    input('keydown', 0, 0, 0, 'é', '', 'Digit2', true, true, true, true, true);
    input('keyup', 0, 0, 0, 'é', '', 'Digit2', false);
    assert.deepEqual(events, [['down', node, 'Digit2', true, true, true, true, true], ['up', otherNode]]);
    const cancel = event => event.preventDefault();
    otherNode.addEventListener('keydown', cancel, { once: true });
    input('keydown', 0, 0, 0, 'Tab', '', 'Tab');
    assert.deepEqual(navigation, []);
    input('keydown', 0, 0, 0, 'Tab', '', 'Tab', false, true);
    assert.deepEqual(navigation, [true]);
    assert.equal(focused, node);
    input('keydown', 0, 0, 0, 'Tab', '', 'Tab', false, false, true);
    assert.deepEqual(navigation, [true], 'Control+Tab is outside sequential element navigation');
    input('blur', 0, 0, 0, '', '');
    assert.equal(focused, node, 'window blur must not blur the element');
    focused = undefined;
  });

  await t.test('pointer focus waits for uncanceled primary mousedown and fresh eligibility', () => {
    enableFocus = true;
    node.eligible = true;
    focused = otherNode;
    const before = pointerFocus.length;
    node.addEventListener('mousedown', event => event.preventDefault(), { once: true });
    input('mousedown', 10, 10, 0, '', '17');
    assert.equal(pointerFocus.length, before);
    assert.equal(focused, otherNode);
    node.addEventListener('mousedown', () => { node.eligible = false; }, { once: true });
    input('mousedown', 10, 10, 0, '', '17');
    assert.equal(focused, otherNode);
    node.eligible = true;
    input('mousedown', 10, 10, 2, '', '17');
    assert.equal(focused, otherNode);
    input('mousedown', 10, 10, 0, '', '17', '', false, true, false, true);
    assert.equal(focused, node);
    focused = undefined;
    enableFocus = false;
    input('pointerreset', 0, 0, 0, '', '');
  });

  await t.test('production RAF scheduling snapshots callbacks and checkpoints cancellation', () => {
    const seen = [];
    let cancelled;
    requestAnimationFrame(function (stamp) {
      assert.equal(this, globalThis);
      seen.push(['first', stamp]);
      microtasks.push(() => { seen.push('microtask'); cancelAnimationFrame(cancelled); });
      requestAnimationFrame(stamp => seen.push(['next', stamp]));
    });
    cancelled = requestAnimationFrame(() => assert.fail('microtask cancelled callback ran'));
    assert.equal(pending.at(-1), true);
    frame();
    assert.deepEqual(seen, [['first', 10], 'microtask']);
    assert.equal(pending.at(-1), true);
    clock = 25;
    frame();
    assert.deepEqual(seen.at(-1), ['next', 25]);
    assert.equal(pending.at(-1), false);
  });

  await t.test('callback failures reach the host and invalid input does not silently succeed', () => {
    assert.deepEqual(errors, []);
    const gpuFailure = new Error('renderer validation failure');
    requestAnimationFrame(() => { throw gpuFailure; });
    frame();
    assert.equal(errors[0], gpuFailure);
    input('wheel', 0, 0, 0, '', '');
    assert.match(errors.at(-1).message, /Unsupported DOM-window input/);
    resize(-1, 200, 1);
    assert.ok(errors.at(-1) instanceof TypeError);
    assert.deepEqual([innerWidth, innerHeight, devicePixelRatio], [800, 500, 1.5]);
    input('mousedown', 1, 2, 0, '', 'missing');
    assert.match(errors.at(-1).message, /Unknown DOM node/);
    const before = globalEvents.length;
    input('click', 1, 2, 0, '', '');
    assert.match(errors.at(-1).message, /Unsupported DOM-window input kind: click/);
    assert.equal(globalEvents.length, before);
  });
});

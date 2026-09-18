import { core } from 'ext:core/mod.js';
import { createInputDispatcher } from 'ext:threejs_native_bootstrap/input.js';

const events = core.loadExtScript('ext:deno_web/02_event.js');
const webidl = core.loadExtScript('ext:deno_webidl/00_webidl.js');
const keys = new EventTarget();
const canvas = new EventTarget();
const empty = new EventTarget();
const deliver = createInputDispatcher({
  keyboardTarget: keys, pointerTarget: canvas, dispatch: events.dispatch,
  markTrusted: events.setIsTrusted,
  validateTarget: target => webidl.assertBranded(target, events.EventTargetPrototype),
  checkpoint: () => core.runMicrotasks(),
});
const assert = (value, message) => { if (!value) throw new Error(message); };
const modifiers = { altKey: false, ctrlKey: true, metaKey: false, shiftKey: true };
const order = [];
let retained;
keys.addEventListener('keydown', event => {
  retained = event;
  assert(event.isTrusted && event.target === keys && event.currentTarget === keys, 'native target/trust');
  assert(event.key === '\u00e9' && event.code === 'Digit2' && event.ctrlKey && event.shiftKey, 'keyboard identity');
  assert(event.repeat && event.location === 0 && event.isComposing === false, 'keyboard state');
  for (const target of [keys, empty]) {
    let error;
    try { target.dispatchEvent(event); } catch (caught) { error = caught; }
    assert(error?.name === 'InvalidStateError' && event.target === keys && event.isTrusted, 'reentrant native event changed');
  }
  try { Object.defineProperty(event, 'isTrusted', { value: false }); } catch {}
  assert(event.isTrusted, 'native trust getter was shadowed');
  try { event.key = 'changed'; } catch {}
  assert(event.key === '\u00e9', 'native fields are writable');
  event.preventDefault();
  assert(event.defaultPrevented, 'input cancellation missing');
  order.push('down');
  Promise.resolve().then(() => order.push('microtask'));
}, { once: true });
keys.addEventListener('keyup', event => { assert(event.isTrusted, 'keyup trust'); order.push('up'); });
deliver({ kind: 'key', pressed: true, key: '\u00e9', code: 'Digit2', location: 0, repeat: true, modifiers });
let receiverError;
try { EventTarget.prototype.dispatchEvent.call({}, retained); } catch (error) { receiverError = error; }
assert(receiverError instanceof TypeError && retained.isTrusted, 'invalid receiver changed native trust');
assert(empty.dispatchEvent(retained) === false, 'canceled redispatch must return false without listeners');
assert(!retained.isTrusted && retained.target === empty, 'public redispatch must reset trust even without listeners');
empty.addEventListener('keydown', event => assert(!event.isTrusted, 'public listener redispatch became trusted'));
assert(empty.dispatchEvent(retained) === false, 'canceled listener redispatch must return false');
deliver({ kind: 'key', pressed: false, key: '\u00e9', code: 'Digit2', location: 0, repeat: false, modifiers });
assert(JSON.stringify(order) === JSON.stringify(['down', 'microtask', 'up']), 'input microtask/order mismatch');
keys.addEventListener('blur', event => { assert(event.isTrusted, 'blur trust'); order.push('blur'); });
deliver({ kind: 'focus', focused: false });
assert(order.at(-1) === 'blur', 'blur depends on animation frames');

let mouse;
canvas.addEventListener('mousedown', event => { mouse = event; });
keys.addEventListener('mousedown', () => { throw new Error('standalone canvas must not fake DOM bubbling'); });
deliver({ kind: 'mouse', event: 'down', position: { x: 120.5, y: 80.25 }, button: 2, buttons: 3, modifiers });
assert(mouse.isTrusted && mouse.button === 2 && mouse.buttons === 3, 'mouse chord snapshot');
assert(mouse.clientX === 120.5 && mouse.offsetY === 80.25 && mouse.pageX === 120.5, 'CSS coordinates changed');
let wheel;
canvas.addEventListener('wheel', event => { wheel = event; event.preventDefault(); }, { passive: false });
deliver({ kind: 'wheel', position: { x: 120, y: 80 }, delta_x: -2, delta_y: 3, delta_mode: 1, buttons: 0, modifiers });
assert(wheel.deltaX === -2 && wheel.deltaY === 3 && wheel.deltaZ === 0 && wheel.deltaMode === 1 && wheel.defaultPrevented, 'wheel units/cancellation changed');

let continued = false;
addEventListener('error', event => {
  if (event.message.includes('native listener failure')) event.preventDefault();
});
canvas.addEventListener('mousemove', () => { throw new Error('native listener failure'); });
canvas.addEventListener('mousemove', () => { continued = true; });
deliver({ kind: 'mouse', event: 'move', position: { x: 1, y: 2 }, button: 0, buttons: 0, modifiers });
assert(continued, 'handled listener error lost later input listener');

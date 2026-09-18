import { core } from 'ext:core/mod.js';
import { createAnimationFrames } from 'ext:dom_window/animation.js';
import { wrap, focusController } from 'ext:html_v8_probe/bindings.js';

const ops = core.ops;
let width;
let height;
let scale;
let buttons = 0;
const pressedTargets = new Map();
const heldKeys = new Set();

function viewport(nextWidth, nextHeight, nextScale) {
  if (![nextWidth, nextHeight].every(value => Number.isInteger(value) && value >= 0)
    || !Number.isFinite(nextScale) || nextScale <= 0) {
    throw new TypeError('Expected physical window dimensions and a positive device scale');
  }
  width = nextWidth;
  height = nextHeight;
  scale = nextScale;
}
viewport(...ops.op_dom_window_viewport());
Object.assign(globalThis, { window: globalThis, self: globalThis });
Object.defineProperties(globalThis, {
  innerWidth: { configurable: true, enumerable: true, get: () => width / scale },
  innerHeight: { configurable: true, enumerable: true, get: () => height / scale },
  devicePixelRatio: { configurable: true, enumerable: true, get: () => scale },
});

const frames = createAnimationFrames({
  now: () => performance.now(),
  checkpoint: () => core.runMicrotasks(),
  reportError: error => core.reportUnhandledException(error),
  setPending: pending => ops.op_dom_window_pending(pending),
});
Object.assign(globalThis, {
  requestAnimationFrame: callback => frames.request(callback),
  cancelAnimationFrame: id => frames.cancel(id),
});

function emit(target, kind, fields = {}, bubbles = false, cancelable = false) {
  const event = new Event(kind, { bubbles, cancelable });
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(event, name, { value, enumerable: true });
  }
  return target.dispatchEvent(event);
}

function resetPointer() {
  buttons = 0;
  pressedTargets.clear();
}

function input(kind, clientX, clientY, button, key, nodeId, physicalCode = '', nativeRepeat = false,
  shiftKey = false, ctrlKey = false, altKey = false, metaKey = false) {
  const modifiers = { shiftKey, ctrlKey, altKey, metaKey };
  if (kind === 'pointerreset') { resetPointer(); return; }
  if (kind === 'blur' || kind === 'focus') {
    if (kind === 'blur') { resetPointer(); heldKeys.clear(); }
    emit(globalThis, kind);
    return;
  }
  if (kind === 'keydown' || kind === 'keyup') {
    if (typeof key !== 'string') throw new TypeError('Expected a keyboard key string');
    const value = key === 'Space' ? ' ' : key;
    const code = physicalCode || (value === ' ' ? 'Space' : value.toLowerCase() === 'r' ? 'KeyR' : '');
    const identity = code || value;
    const repeat = kind === 'keydown' && (nativeRepeat || heldKeys.has(identity));
    if (kind === 'keydown') heldKeys.add(identity);
    else heldKeys.delete(identity);
    const target = focusController.activeElement() ?? document.body ?? document;
    const accepted = emit(target, kind, { key: value, code, repeat, isComposing: false, ...modifiers }, true, true);
    if (kind === 'keydown' && value === 'Tab' && accepted && !ctrlKey && !altKey && !metaKey) {
      focusController.navigate(shiftKey);
    }
    return;
  }
  if (!['mousedown', 'mouseup', 'mousemove'].includes(kind)) {
    throw new TypeError(`Unsupported DOM-window input kind: ${kind}`);
  }
  if (![clientX, clientY].every(Number.isFinite) || typeof nodeId !== 'string') {
    throw new TypeError('Expected CSS pointer coordinates and a DOM node ID');
  }
  if (kind !== 'mousemove' && (!Number.isInteger(button) || button < 0 || button > 4)) {
    throw new TypeError('Expected a supported mouse button');
  }
  const bit = [1, 4, 2, 8, 16][button] ?? 0;
  const target = nodeId ? wrap(nodeId) : globalThis;
  const pressedTarget = pressedTargets.get(button);
  if (kind === 'mousedown') {
    buttons |= bit;
    pressedTargets.set(button, nodeId);
  }
  if (kind === 'mouseup') {
    buttons &= ~bit;
    pressedTargets.delete(button);
  }
  const fields = { clientX, clientY, button: kind === 'mousemove' ? 0 : button, buttons, detail: 0, ...modifiers };
  const accepted = emit(target, kind, fields, true, true);
  // Eligibility is resolved after handlers, which may disable or detach the target.
  if (kind === 'mousedown' && button === 0 && accepted && nodeId) focusController.pointer(target);
  // This fixture activates only matching primary presses, not common ancestors or auxiliary buttons.
  if (kind === 'mouseup' && button === 0 && pressedTarget === nodeId) {
    emit(target, 'click', { ...fields, detail: 1 }, true, true);
  }
}

function callback(action) {
  return (...args) => {
    try {
      action(...args);
      core.runMicrotasks();
    } catch (error) {
      core.reportUnhandledException(error);
    }
  };
}

// The host releases its DOM borrow before invoking these synchronous callbacks.
ops.op_dom_window_bind(
  callback(() => frames.dispatch()),
  callback((nextWidth, nextHeight, nextScale) => {
    viewport(nextWidth, nextHeight, nextScale);
    emit(globalThis, 'resize');
  }),
  callback(input),
);

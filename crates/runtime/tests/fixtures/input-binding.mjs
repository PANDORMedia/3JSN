import { createInputDispatcher } from '../../src/input.js';

const core = Deno.core;
const events = core.loadExtScript('ext:deno_web/02_event.js');
const webidl = core.loadExtScript('ext:deno_webidl/00_webidl.js');
const canvas = new EventTarget();
canvas.addEventListener('wheel', event => { globalThis.observedNativeWheel = event; });
core.ops.op_native_bind_input(createInputDispatcher({
  keyboardTarget: globalThis, pointerTarget: canvas,
  dispatch: events.dispatch, markTrusted: events.setIsTrusted,
  validateTarget: target => webidl.assertBranded(target, events.EventTargetPrototype),
  checkpoint: () => core.runMicrotasks(),
}));

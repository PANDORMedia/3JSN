import { answer } from './imported.mjs';
const events = [];
await new Promise(resolve => {
  queueMicrotask(() => events.push('microtask'));
  setTimeout(() => { events.push('timer'); resolve(); }, 1);
});
if (answer !== 42 || events.join() !== 'microtask,timer') throw new Error('Module/timer ordering failed');
if (new TextDecoder().decode(new TextEncoder().encode('3JSN 🐸')) !== '3JSN 🐸') {
  throw new Error('Text encoding failed');
}
const target = new EventTarget();
let calls = 0;
target.addEventListener('ready', () => calls++, { once: true });
target.dispatchEvent(new Event('ready'));
target.dispatchEvent(new Event('ready'));
if (calls !== 1) throw new Error('EventTarget once behavior failed');
const origin = performance.timeOrigin;
const firstTime = performance.now();
if (!Number.isFinite(origin) || origin <= 0 || performance.timeOrigin !== origin || performance.now() < firstTime) {
  throw new Error('Performance clock initialization failed');
}

let reported;
addEventListener('error', event => { reported = event; event.preventDefault(); }, { once: true });
const throwing = new EventTarget();
let continued = false;
throwing.addEventListener('action', () => { throw new Error('handled listener failure'); });
throwing.addEventListener('action', () => { continued = true; });
throwing.dispatchEvent(new Event('action'));
if (!continued || !(reported instanceof ErrorEvent) || reported.error.message !== 'handled listener failure' || !reported.filename.endsWith('modules.mjs')) {
  throw new Error('Listener exception reporting/continuation failed');
}

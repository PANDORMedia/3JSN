import { core } from 'ext:core/mod.js';
import { createAnimationFrames } from 'ext:demo_scheduler/animation.js';
let timestamp = 0;
let pending = false;
const frames = createAnimationFrames({
  now: () => timestamp,
  checkpoint: () => core.runMicrotasks(),
  reportError: error => { throw error; },
  setPending: value => { pending = value; },
});
Object.assign(globalThis, {
  window: globalThis, self: globalThis, innerWidth: 960, innerHeight: 640, devicePixelRatio: 1,
  requestAnimationFrame: callback => frames.request(callback),
  cancelAnimationFrame: id => frames.cancel(id),
  __demoCheckpoints: [],
  __demoFrame() {
    if (!pending) throw Error('Demo stopped requesting animation frames');
    timestamp += 1000 / 60;
    frames.dispatch();
  },
  __demoStopped: () => !pending,
});
const log = console.log.bind(console);
console.log = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
    const value = JSON.parse(args[0]);
    if (value.webglWindow) __demoCheckpoints.push(value.webglWindow);
  }
  log(...args);
};

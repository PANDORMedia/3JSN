import { createAnimationFrames } from '../../src/animation.js';

const observed = [];
let now = 100;
let pending;
let cancelled;
const frames = createAnimationFrames({
  now: () => now,
  checkpoint: () => Deno.core.runMicrotasks(),
  reportError: error => reportError(error),
  setPending: value => { pending = value; },
});
addEventListener('error', event => {
  if (event.message.includes('frame callback failure')) {
    event.preventDefault(); observed.push('handled');
  }
});
frames.request(time => {
  observed.push(`first:${time}`);
  Promise.resolve().then(() => { observed.push('microtask'); frames.cancel(cancelled); });
  frames.request(time => observed.push(`deferred:${time}`));
});
cancelled = frames.request(() => { throw new Error('cancelled callback executed'); });
frames.request(() => { throw new Error('frame callback failure'); });
frames.request(time => observed.push(`last:${time}`));
frames.dispatch();
const expected = ['first:100', 'microtask', 'handled', 'last:100'];
if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(`native checkpoint order: ${JSON.stringify(observed)}`);
if (!pending) throw new Error('next native frame was lost');
now = 125;
frames.dispatch();
if (observed.at(-1) !== 'deferred:125' || pending) throw new Error('next-frame scheduling was incorrect');

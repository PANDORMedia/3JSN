import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnimationFrames } from '../../crates/runtime/src/animation.js';

test('native frames snapshot callbacks, share time, and honor cancellation during dispatch', () => {
  const seen = [];
  const microtasks = [];
  const failures = [];
  let time = 10;
  let pending;
  const frames = createAnimationFrames({ now: () => time,
    checkpoint: () => { while (microtasks.length) microtasks.shift()(); },
    reportError: error => failures.push(error.message),
    setPending: value => { pending = value; },
  });
  let cancelled;
  frames.request(function (stamp) {
    assert.equal(this, globalThis);
    seen.push(['first', stamp]);
    microtasks.push(() => { seen.push(['microtask']); frames.cancel(cancelled); });
    frames.request(stamp => seen.push(['next', stamp]));
  });
  cancelled = frames.request(() => assert.fail('cancelled callback ran'));
  frames.request(() => { throw new Error('handled callback failure'); });
  frames.request(stamp => seen.push(['last', stamp]));
  frames.dispatch();
  assert.deepEqual(seen, [['first', 10], ['microtask'], ['last', 10]]);
  assert.deepEqual(failures, ['handled callback failure']);
  assert.equal(pending, true);
  time = 25;
  frames.dispatch();
  assert.deepEqual(seen.at(-1), ['next', 25]);
  assert.equal(pending, false);
  assert.throws(() => frames.request(null), TypeError);
});

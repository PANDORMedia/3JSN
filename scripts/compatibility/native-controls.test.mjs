import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneControls } from '../../examples/spinning-scene/controls.mjs';

function fixture(t) {
  const camera = {
    position: {
      x: 4.5, y: 3.2, z: 6,
      set(x, y, z) { Object.assign(this, { x, y, z }); },
    },
    lookAt(x, y, z) { this.target = [x, y, z]; },
  };
  const canvas = new EventTarget();
  const keys = new EventTarget();
  const changes = [];
  const controls = createSceneControls(camera, canvas, keys, change => changes.push(change));
  t.after(() => controls.dispose());
  return { camera, canvas, keys, changes, controls };
}

function dispatch(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(fields)) {
    // Browser event data are read-only; assigning test-only mutable fields hides binding bugs.
    Object.defineProperty(event, name, { value, enumerable: true });
  }
  target.dispatchEvent(event);
  return event;
}

const key = (f, code, repeat = false) => dispatch(f.keys, 'keydown', { code, repeat });
const mouse = (f, type, clientX, clientY, button = 0, buttons = 1) =>
  dispatch(f.canvas, type, { clientX, clientY, button, buttons });
const wheel = (f, deltaY, deltaMode = 0) => dispatch(f.canvas, 'wheel', { deltaY, deltaMode });
const position = f => [f.camera.position.x, f.camera.position.y, f.camera.position.z];
const distance = f => Math.hypot(f.camera.position.x, f.camera.position.y - 0.2, f.camera.position.z);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10,
  `${message ?? 'values differ'}: ${actual} != ${expected}`);
const samePosition = (actual, expected) => actual.forEach((value, index) => near(value, expected[index]));

test('Space pauses animation, ignores held-key repeats, and resumes without paused-time catch-up', t => {
  const f = fixture(t);
  assert.equal(f.controls.advance(100), 0);
  near(f.controls.advance(350), 0.25);
  assert.equal(key(f, 'Space').defaultPrevented, true);
  assert.equal(f.changes.at(-1).paused, true);
  const count = f.changes.length;
  key(f, 'Space', true);
  assert.equal(f.changes.length, count);
  near(f.controls.advance(1_000), 0.25);
  near(f.controls.advance(100_000), 0.25);
  assert.equal(key(f, 'Space').defaultPrevented, true);
  assert.equal(f.changes.at(-1).paused, false);
  near(f.controls.advance(100_020), 0.25);
  key(f, 'Space', true);
  near(f.controls.advance(100_040), 0.27);
  near(f.controls.advance(100_060), 0.29);
});

test('pause and resume without any paused frames cannot add the hidden interval', t => {
  const f = fixture(t);
  f.controls.advance(0);
  near(f.controls.advance(1_000), 1);
  key(f, 'Space');
  key(f, 'Space', true);
  assert.equal(f.changes.at(-1).paused, true);
  key(f, 'Space');
  near(f.controls.advance(1_000_000), 1);
  near(f.controls.advance(1_000_016), 1.016);
});

test('R restores the initial camera and animation time while preserving a paused state', t => {
  const f = fixture(t);
  const initial = position(f);
  f.controls.advance(0);
  near(f.controls.advance(2_000), 2);
  key(f, 'ArrowLeft');
  key(f, 'ArrowUp');
  wheel(f, 100);
  assert.notDeepEqual(position(f), initial);
  const changed = position(f);
  const count = f.changes.length;
  key(f, 'KeyR', true);
  samePosition(position(f), changed);
  assert.equal(f.changes.length, count);
  near(f.controls.advance(2_025), 2.025);
  key(f, 'Space');
  assert.equal(key(f, 'KeyR').defaultPrevented, true);
  samePosition(position(f), initial);
  assert.deepEqual(f.camera.target, [0, 0.2, 0]);
  assert.equal(f.changes.at(-1).paused, true);
  assert.equal(f.controls.advance(5_000), 0);
  key(f, 'Space');
  assert.equal(f.controls.advance(5_025), 0);
  near(f.controls.advance(5_050), 0.025);
  key(f, 'KeyR');
  assert.equal(f.controls.advance(10_000), 0);
  near(f.controls.advance(10_025), 0.025);
});

test('arrow keys orbit in opposite directions, retain radius, and allow held-key movement', t => {
  const f = fixture(t);
  const initial = position(f);
  const radius = distance(f);
  assert.equal(key(f, 'ArrowLeft').defaultPrevented, true);
  assert.ok(f.camera.position.x < initial[0]);
  near(distance(f), radius);
  key(f, 'ArrowRight');
  samePosition(position(f), initial);
  key(f, 'ArrowUp');
  assert.ok(f.camera.position.y > initial[1]);
  near(distance(f), radius);
  key(f, 'ArrowDown');
  samePosition(position(f), initial);
  key(f, 'ArrowRight');
  const first = f.camera.position.x;
  key(f, 'ArrowRight', true);
  assert.ok(f.camera.position.x > first);
  near(distance(f), radius);
  assert.deepEqual(f.camera.target, [0, 0.2, 0]);
  const count = f.changes.length;
  const current = position(f);
  assert.equal(key(f, 'KeyQ').defaultPrevented, false);
  assert.equal(f.changes.length, count);
  samePosition(position(f), current);
});

test('pitch stays away from the orbit poles and reverses after reaching either limit', t => {
  const f = fixture(t);
  const radius = distance(f);
  for (let i = 0; i < 100; i++) key(f, 'ArrowUp', true);
  const upper = position(f);
  assert.ok(upper[1] > 0.2);
  assert.ok(Math.hypot(upper[0], upper[2]) > radius * 0.1);
  near(distance(f), radius);
  key(f, 'ArrowUp');
  samePosition(position(f), upper);
  key(f, 'ArrowDown');
  assert.ok(f.camera.position.y < upper[1]);
  for (let i = 0; i < 100; i++) key(f, 'ArrowDown', true);
  const lower = position(f);
  assert.ok(lower[1] < 0.2);
  assert.ok(Math.hypot(lower[0], lower[2]) > radius * 0.1);
  near(distance(f), radius);
  key(f, 'ArrowDown');
  samePosition(position(f), lower);
  key(f, 'ArrowUp');
  assert.ok(f.camera.position.y > lower[1]);
});

test('only the primary button starts dragging and chords retain its original anchor', t => {
  const f = fixture(t);
  const reference = fixture(t);
  const initial = position(f);
  assert.equal(mouse(f, 'mousedown', 10, 20, 2, 2).defaultPrevented, false);
  mouse(f, 'mousemove', 30, 40, 0, 1);
  samePosition(position(f), initial);
  assert.equal(f.changes.length, 0);
  assert.equal(mouse(f, 'mousedown', 10, 20).defaultPrevented, true);
  mouse(reference, 'mousedown', 10, 20);
  mouse(f, 'mousedown', 400, 200, 2, 3);
  mouse(f, 'mousemove', 30, 40, 0, 3);
  mouse(reference, 'mousemove', 30, 40);
  samePosition(position(f), position(reference));
  assert.notDeepEqual(position(f), initial);
  mouse(f, 'mouseup', 30, 40, 2, 1);
  mouse(f, 'mousemove', 40, 45);
  mouse(reference, 'mousemove', 40, 45);
  samePosition(position(f), position(reference));
});

for (const end of ['primary release', 'lost primary button', 'mouse leave', 'window blur']) {
  test(`${end} ends dragging until a fresh primary press`, t => {
    const f = fixture(t);
    mouse(f, 'mousedown', 10, 20);
    mouse(f, 'mousemove', 20, 30);
    const stopped = position(f);
    const count = f.changes.length;
    switch (end) {
      case 'primary release': mouse(f, 'mouseup', 20, 30, 0, 2); break;
      case 'lost primary button': mouse(f, 'mousemove', 400, 200, 0, 2); break;
      case 'mouse leave': dispatch(f.canvas, 'mouseleave'); break;
      case 'window blur': dispatch(f.keys, 'blur'); break;
    }
    mouse(f, 'mousemove', 440, 240, 0, 3);
    samePosition(position(f), stopped);
    assert.equal(f.changes.length, count);
    mouse(f, 'mousedown', 100, 100);
    mouse(f, 'mousemove', 110, 105);
    assert.notDeepEqual(position(f), stopped);
    assert.equal(f.changes.length, count + 1);
  });
}

test('wheel pixels, lines and pages normalize to equivalent zoom gestures', t => {
  const pixels = fixture(t), lines = fixture(t), pages = fixture(t);
  const initial = position(pixels);
  for (const [f, delta, mode] of [[pixels, 30, 0], [lines, 1, 1], [pages, 0.2, 2]]) {
    assert.equal(wheel(f, delta, mode).defaultPrevented, true);
    assert.ok(distance(f) > Math.hypot(initial[0], initial[1] - 0.2, initial[2]));
    assert.deepEqual(f.camera.target, [0, 0.2, 0]);
  }
  samePosition(position(pixels), position(lines));
  samePosition(position(pixels), position(pages));
  wheel(pixels, -30, 0);
  wheel(lines, -1, 1);
  wheel(pages, -0.2, 2);
  for (const f of [pixels, lines, pages]) samePosition(position(f), initial);
});

test('large wheel input clamps camera distance and an opposite gesture leaves the clamp', t => {
  const f = fixture(t);
  const initial = position(f);
  wheel(f, 1_000_000);
  near(distance(f), 20);
  const far = position(f);
  wheel(f, 1_000_000, 2);
  samePosition(position(f), far);
  wheel(f, -1);
  assert.ok(distance(f) < 20);
  wheel(f, -1_000_000);
  near(distance(f), 3);
  const close = position(f);
  wheel(f, -1_000_000, 1);
  samePosition(position(f), close);
  wheel(f, 1);
  assert.ok(distance(f) > 3);
  const current = position(f);
  near(current[0] / current[2], initial[0] / initial[2]);
  near((current[1] - 0.2) / current[2], (initial[1] - 0.2) / initial[2]);
});

test('dispose removes event effects, ends active drag, and is safe to repeat', t => {
  const f = fixture(t);
  mouse(f, 'mousedown', 10, 10);
  mouse(f, 'mousemove', 20, 20);
  const stopped = position(f);
  const count = f.changes.length;
  f.controls.dispose();
  f.controls.dispose();
  mouse(f, 'mousemove', 40, 40);
  assert.equal(mouse(f, 'mousedown', 10, 10).defaultPrevented, false);
  mouse(f, 'mousemove', 60, 60);
  mouse(f, 'mouseup', 60, 60, 0, 0);
  dispatch(f.canvas, 'mouseleave');
  dispatch(f.keys, 'blur');
  assert.equal(wheel(f, 300).defaultPrevented, false);
  for (const code of ['Space', 'KeyR', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(key(f, code).defaultPrevented, false);
  }
  samePosition(position(f), stopped);
  assert.equal(f.changes.length, count);
  const replacements = [];
  const replacement = createSceneControls(f.camera, f.canvas, f.keys, value => replacements.push(value));
  t.after(() => replacement.dispose());
  mouse(f, 'mousemove', 80, 80);
  samePosition(position(f), stopped);
  key(f, 'ArrowRight');
  assert.notDeepEqual(position(f), stopped);
  assert.equal(replacements.length, 1);
  assert.equal(f.changes.length, count);
});

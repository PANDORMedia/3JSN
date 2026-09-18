import './app.bundle.mjs';
let frames = 0;
function fail() {
  if (++frames === 8) throw new Error('expected-DOM-window-frame-failure');
  requestAnimationFrame(fail);
}
requestAnimationFrame(fail);

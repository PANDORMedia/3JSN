import './three-window.mjs';

const canvas = nativeWindow.canvas;
let records = 0;
function observe(event) {
  if (!event.isTrusted) throw new Error(`Native ${event.type} lost its trusted origin`);
  if (records++ >= 64) return;
  const record = { type: event.type, trusted: event.isTrusted, width: innerWidth,
    height: innerHeight, scale: devicePixelRatio };
  for (const key of ['key', 'code', 'location', 'repeat', 'altKey', 'ctrlKey', 'metaKey',
    'shiftKey', 'button', 'buttons', 'clientX', 'clientY', 'deltaX', 'deltaY', 'deltaMode']) {
    if (key in event) record[key] = event[key];
  }
  console.log(JSON.stringify({ nativeInputObserved: record }));
}
for (const type of ['keydown', 'keyup', 'focus', 'blur']) addEventListener(type, observe);
for (const type of ['mousedown', 'mouseup', 'wheel', 'mouseleave']) canvas.addEventListener(type, observe);

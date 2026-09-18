for (const name of ['Deno', '__bootstrap', '__infra']) {
  if (name in globalThis || Object.getOwnPropertyDescriptor(globalThis, name)) {
    throw new Error(`Privileged global remained: ${name}`);
  }
}
for (const specifier of ['ext:core/mod.js', 'ext:core/ops', 'ext:threejs_native_bootstrap/bootstrap.js']) {
  let rejected = false;
  try { await import(specifier); } catch { rejected = true; }
  if (!rejected) throw new Error(`Application imported privileged module: ${specifier}`);
}
const target = new EventTarget();
let events = 0;
target.addEventListener('ready', () => events++, { once: true });
await new Promise(resolve => setTimeout(() => {
  target.dispatchEvent(new Event('ready'));
  target.dispatchEvent(new Event('ready'));
  resolve();
}, 1));
if (events !== 1) throw new Error('Captured event/timer bindings failed after sealing');
for (const name of ['Deno', '__bootstrap', '__infra']) {
  if (name in globalThis) throw new Error(`Privileged global reappeared: ${name}`);
}

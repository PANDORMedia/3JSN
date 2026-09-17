import { addModule } from './add-module.mjs';

const moduleReady = WebAssembly.instantiate(addModule);
self.addEventListener('message', async (event) => {
  const { instance } = await moduleReady;
  const { id, payload, buffer } = event.data;
  if (buffer) {
    const values = new Int32Array(buffer);
    values[0] = instance.exports.add(values[0], values[1]);
    self.postMessage({ id, value: values[0], buffer, moduleUrl: import.meta.url }, [buffer]);
  } else {
    self.postMessage({ id, payload, result: instance.exports.add(20, 22), hasDocument: typeof document !== 'undefined' });
  }
});

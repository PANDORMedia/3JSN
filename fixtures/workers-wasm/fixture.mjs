import { runFixture, withTimeout } from '../harness.mjs';

await runFixture('workers-wasm', async (check) => {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  let id = 0;
  let received = 0;
  const pending = new Map();
  worker.addEventListener('message', ({ data }) => {
    received++;
    const request = pending.get(data.id);
    if (request) { pending.delete(data.id); request.resolve(data); }
  });
  worker.addEventListener('error', (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message));
    pending.clear();
  });
  function send(message, transfer = []) {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    worker.postMessage({ id: requestId, ...message }, transfer);
    return withTimeout(response, `worker request ${requestId}`);
  }
  try {
    const original = { nested: { value: 'original' }, list: [1, 2, 3] };
    const first = send({ payload: original });
    original.nested.value = 'changed after send';
    const result = await first;
    check('Module worker executes imported Wasm addition', result.result === 42, result.result);
    check('Structured clone isolates nested objects', result.payload.nested.value === 'original' && result.payload.list.join(',') === '1,2,3');
    check('Worker has no document global', result.hasDocument === false);
    const values = new Int32Array([17, 25]);
    const reply = send({ buffer: values.buffer }, [values.buffer]);
    check('Transfer detaches the sender ArrayBuffer', values.buffer.byteLength === 0);
    const transferred = await reply;
    check('Worker returns a transferred Wasm result', transferred.buffer instanceof ArrayBuffer && new Int32Array(transferred.buffer)[0] === 42 && transferred.value === 42);
    check('Worker import resolves relative to its module URL', new URL(transferred.moduleUrl).pathname.endsWith('/fixtures/workers-wasm/worker.mjs'));
    const sequence = await Promise.all([send({ payload: 'first' }), send({ payload: 'second' })]);
    check('Messages preserve request identity and values', sequence[0].payload === 'first' && sequence[1].payload === 'second' && sequence[0].id < sequence[1].id);
    worker.terminate();
    const count = received;
    worker.postMessage({ id: ++id, payload: 'after termination' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('Terminated worker emits no response to subsequent messaging', received === count, { before: count, after: received });
    return { wasm: 'original i32 addition module', worker: 'module', sharedMemory: 'not tested', cancellation: 'explicit Worker.terminate; no late response within 100 ms' };
  } finally {
    worker.terminate();
  }
});

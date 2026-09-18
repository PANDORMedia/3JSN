import { runFixture } from '../harness.mjs';
import { runCanvasContract } from './contract.mjs';

await runFixture('webgpu-canvas', async check => {
  check('WebGPU is available', !!navigator.gpu);
  const adapter = await navigator.gpu.requestAdapter();
  check('hardware adapter', !!adapter && !adapter.info.isFallbackAdapter, adapter?.info.description);
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  try {
    const observations = await runCanvasContract(check, device);
    await device.queue.onSubmittedWorkDone();
    check('no unexpected GPU errors', errors.length === 0, errors);
    return { adapter: adapter.info.description, ...observations,
      scope: 'Programmatic DOM/WebGPU canvas contract; no native input or screenshot parity.' };
  } finally { device.destroy(); }
});

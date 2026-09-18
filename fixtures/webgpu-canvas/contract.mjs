function throwsName(run) {
  try { run(); return null; }
  catch (error) { return error.name; }
}

async function clearAndRead(device, texture, color) {
  const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
      clearValue: color, loadOp: 'clear', storeOp: 'store' }] });
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const result = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
    buffer.unmap();
    return result;
  } finally { buffer.destroy(); }
}

async function rejectedCopy(device, texture) {
  device.pushErrorScope('validation');
  const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
  } finally { buffer.destroy(); }
  const error = await device.popErrorScope();
  return error?.constructor.name ?? null;
}

export async function runCanvasContract(check, device) {
  const canvas = document.createElement('canvas');
  const second = document.createElement('canvas');
  const container = document.getElementById('canvases');
  container.appendChild(canvas);
  container.appendChild(second);
  const contexts = [];
  try {
    check('canvas DOM brand', canvas instanceof HTMLCanvasElement && canvas instanceof HTMLElement && canvas instanceof EventTarget);
    check('default bitmap dimensions', canvas.width === 300 && canvas.height === 150, [canvas.width, canvas.height]);
    check('absent dimensions stay absent attributes', canvas.getAttribute('width') === null && canvas.getAttribute('height') === null);
    canvas.width = 64.9;
    canvas.height = 32;
    check('IDL dimension reflection', canvas.width === 64 && canvas.getAttribute('width') === '64' && canvas.height === 32);
    canvas.setAttribute('width', 'invalid');
    check('invalid attribute defaults', canvas.width === 300, canvas.width);
    canvas.setAttribute('width', ' 40tail');
    check('HTML integer parsing', canvas.width === 40, canvas.width);
    canvas.width = 64;
    canvas.style.width = '128px';
    canvas.style.height = '96px';
    const rect = canvas.getBoundingClientRect();
    check('CSS size differs from bitmap size', canvas.width === 64 && canvas.height === 32 && rect.width === 128 && rect.height === 96,
      { bitmap: [canvas.width, canvas.height], css: [rect.width, rect.height] });
    check('unknown context is null', canvas.getContext('not-a-context') === null);
    const context = canvas.getContext('webgpu');
    contexts.push(context);
    check('native context brand and identity', context instanceof GPUCanvasContext && context.canvas === canvas && canvas.getContext('webgpu') === context);
    check('incompatible context mode is null', canvas.getContext('2d') === null && canvas.getContext('webgl2') === null);
    check('initial configuration is null', context.getConfiguration() === null);
    const unconfiguredError = throwsName(() => context.getCurrentTexture());
    check('unconfigured texture throws InvalidStateError', unconfiguredError === 'InvalidStateError', unconfiguredError);
    const configuration = { device, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: 'premultiplied' };
    context.configure(configuration);
    const first = context.getCurrentTexture();
    check('current texture identity and metadata', first === context.getCurrentTexture() && first.width === 64 && first.height === 32 && first.mipLevelCount === 1 && first.sampleCount === 1 && first.usage === configuration.usage);
    const red = await clearAndRead(device, first, [1, 0, 0, 1]);
    check('rendered canvas texture is readable', red.join() === '255,0,0,255', red);
    const beforeInvalid = context.getCurrentTexture();
    const invalidError = throwsName(() => context.configure({ ...configuration, format: 'rgba32float' }));
    check('invalid format throws and preserves current texture', invalidError === 'TypeError' && context.getCurrentTexture() === beforeInvalid, invalidError);
    const prior = context.getCurrentTexture();
    context.configure(configuration);
    check('valid reconfigure replaces current texture', context.getCurrentTexture() !== prior);
    check('reconfigured texture expires', await rejectedCopy(device, prior) === 'GPUValidationError');
    const beforeResize = context.getCurrentTexture();
    canvas.width = 80;
    const resized = context.getCurrentTexture();
    check('bitmap resize preserves context and changes texture', canvas.getContext('webgpu') === context && resized !== beforeResize && resized.width === 80 && resized.height === 32);
    check('resized texture expires', await rejectedCopy(device, beforeResize) === 'GPUValidationError');
    const sameSize = context.getCurrentTexture();
    canvas.width = 80;
    check('redundant width assignment replaces WebGPU texture', context.getCurrentTexture() !== sameSize);
    const oldForAttribute = context.getCurrentTexture();
    canvas.setAttribute('height', '48');
    check('attribute resize reaches context', context.getCurrentTexture() !== oldForAttribute && context.getCurrentTexture().height === 48);
    second.width = 16; second.height = 16;
    const other = second.getContext('webgpu');
    contexts.push(other);
    other.configure(configuration);
    const otherTexture = other.getCurrentTexture();
    const green = await clearAndRead(device, otherTexture, [0, 1, 0, 1]);
    check('independent canvas context and pixels', other !== context && other.canvas === second && green.join() === '0,255,0,255', green);
    const beforeDetach = context.getCurrentTexture();
    container.removeChild(canvas); container.appendChild(canvas);
    check('detach and reinsert preserve context', canvas.getContext('webgpu') === context && context.getCurrentTexture() === beforeDetach);
    context.unconfigure();
    check('unconfigure clears state and expires texture', context.getConfiguration() === null && await rejectedCopy(device, beforeDetach) === 'GPUValidationError');
    check('unconfigure does not reset context mode', canvas.getContext('webgpu') === context && canvas.getContext('2d') === null);
    context.configure({ device, format: 'rgba8unorm' });
    const defaultUsage = context.getCurrentTexture();
    check('default usage is only render attachment', defaultUsage.usage === GPUTextureUsage.RENDER_ATTACHMENT, defaultUsage.usage);
    check('host cannot silently grant COPY_SRC usage', await rejectedCopy(device, defaultUsage) === 'GPUValidationError');
    return { bitmap: [canvas.width, canvas.height], contextCount: 2 };
  } finally {
    for (const context of contexts) context?.unconfigure();
    if (canvas.parentNode === container) container.removeChild(canvas);
    if (second.parentNode === container) container.removeChild(second);
  }
}

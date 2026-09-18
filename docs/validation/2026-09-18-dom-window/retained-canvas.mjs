const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const canvas = document.getElementById('scene');
const context = canvas.getContext('webgpu');
context.configure({device,format:'rgba8unorm',alphaMode:'opaque'});
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:[0,1,1,1]}]});
pass.end(); device.queue.submit([encoder.finish()]);
requestAnimationFrame(() => { document.getElementById('status').textContent = 'Retained canvas; no additional drawing'; });

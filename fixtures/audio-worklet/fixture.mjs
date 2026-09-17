import { runFixture, withTimeout } from '../harness.mjs';

await runFixture('audio-worklet', async (check) => {
  const sampleRate = 48000;
  const context = new OfflineAudioContext(1, 2048, sampleRate);
  const constant = new ConstantSourceNode(context, { offset: 0.5 });
  const gain = new GainNode(context, { gain: 1 });
  constant.connect(gain).connect(context.destination);
  const startFrame = 256;
  const endFrame = 1280;
  constant.start(startFrame / sampleRate);
  gain.gain.setValueAtTime(0.5, 768 / sampleRate);
  constant.stop(endFrame / sampleRate);
  let ended = false;
  constant.addEventListener('ended', () => { ended = true; }, { once: true });
  const rendered = await withTimeout(context.startRendering(), 'offline audio rendering');
  const samples = rendered.getChannelData(0);
  const allNear = (start, end, value) => samples.subarray(start, end).every((sample) => Math.abs(sample - value) < 0.000001);
  check('Offline buffer retains requested format', rendered.sampleRate === sampleRate && rendered.length === 2048 && rendered.numberOfChannels === 1);
  check('Scheduled source starts at the requested sample frame', allNear(0, startFrame, 0) && allNear(startFrame, 768, 0.5));
  check('Gain automation applies at the scheduled audio time', allNear(768, endFrame, 0.25));
  check('Scheduled stop restores silence', allNear(endFrame, 2048, 0));
  check('Offline audio clock matches rendered sample count', Math.abs(context.currentTime - 2048 / sampleRate) < 0.000001 && context.state === 'closed', { time: context.currentTime, state: context.state });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('Scheduled source emits ended', ended);

  const workletContext = new OfflineAudioContext(1, 512, sampleRate);
  await withTimeout(workletContext.audioWorklet.addModule(new URL('./clock-processor.mjs', import.meta.url)), 'worklet module loading');
  const node = new AudioWorkletNode(workletContext, '3jsn-clock-reference');
  const message = withTimeout(new Promise((resolve) => { node.port.onmessage = ({ data }) => resolve(data); }), 'worklet clock message');
  node.connect(workletContext.destination);
  try {
    const output = await withTimeout(workletContext.startRendering(), 'worklet rendering');
    const { blocks } = await message;
    check('Worklet produces the requested output samples', output.getChannelData(0).every((sample) => sample === 0.125));
    check('Worklet message port returns consecutive rendering quanta', blocks.length === 3 && blocks.every((block, index) => block.frame === index * blocks[0].length && block.rate === sampleRate && Math.abs(block.time - block.frame / sampleRate) < 0.000001), blocks);
    return { mode: 'OfflineAudioContext', sampleRate, physicalAudio: 'not tested', microphone: 'not accessed', workletQuantum: blocks[0].length };
  } finally {
    node.disconnect();
    node.port.close();
    constant.disconnect();
    gain.disconnect();
  }
});

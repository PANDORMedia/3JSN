class ClockProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    channel.fill(0.125);
    if (this.blocks.length < 3) {
      this.blocks.push({ frame: currentFrame, time: currentTime, rate: sampleRate, length: channel.length });
      if (this.blocks.length === 3) this.port.postMessage({ blocks: this.blocks });
    }
    return true;
  }
}

registerProcessor('3jsn-clock-reference', ClockProcessor);

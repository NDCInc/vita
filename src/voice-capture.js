// Runs on the browser audio thread. Transfer a few milliseconds of PCM at a time.
class VitaMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage('flushed');
    };
  }
  flush() {
    if (!this.used) return;
    const data = this.buffer.subarray(0,this.used).slice();
    this.port.postMessage(data,[data.buffer]);
    this.used = 0;
  }
  process(input) {
    const channels = input[0];
    if (!channels?.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.buffer[this.used++] = sample/channels.length;
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('vita-microphone',VitaMicrophone);

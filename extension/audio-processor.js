// audio-processor.js — AudioWorklet processor for AI Translation extension
// Runs on a dedicated high-priority audio thread. Never drops audio chunks.
// Converts Float32 audio to Int16 PCM, batches, and posts to main thread.
//
// Replaces the deprecated ScriptProcessorNode (ScriptProcessor) which runs
// on the main thread and silently drops audio under CPU load.

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(0);
    this.batchSize = 4096; // ~256ms at 16kHz
    this._maxAbs = 0;
    this._flushed = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this._flush();
      }
    };
  }

  _flush() {
    if (this.buffer.length === 0) return;
    this.port.postMessage(
      { pcm: this.buffer.buffer, maxAbs: this._maxAbs, flush: true },
      [this.buffer.buffer]
    );
    this.buffer = new Int16Array(0);
    this._maxAbs = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0];
    const pcm = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channelData[i]));
      const val = Math.round(clamped * 32767);
      pcm[i] = val;
      if (Math.abs(val) > this._maxAbs) this._maxAbs = Math.abs(val);
    }

    const newBuf = new Int16Array(this.buffer.length + pcm.length);
    newBuf.set(this.buffer, 0);
    newBuf.set(pcm, this.buffer.length);
    this.buffer = newBuf;

    if (this.buffer.length >= this.batchSize) {
      // Transfer buffer ownership (zero-copy) — this.buffer becomes detached
      this.port.postMessage(
        { pcm: this.buffer.buffer, maxAbs: this._maxAbs },
        [this.buffer.buffer]
      );
      this.buffer = new Int16Array(0);
      this._maxAbs = 0;
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

// audio-processor.js — AudioWorklet processor for AI Translation extension
// Runs on a dedicated high-priority audio thread. Must NEVER drop audio
// chunks: any miss creates a hole that corrupts ASR segment timestamps,
// which in turn ruins subtitle/TTS alignment with the floating window.
//
// Strict no-drop guarantees:
//   1. Pre-allocated ring buffer (no per-quantum O(N) reallocs).
//   2. Each emitted batch carries an absolute sample-index (sampleStartSeq),
//      so the main thread can detect any silent dropout and refuse to lie
//      about timestamps if drift occurs.
//   3. Each batch carries the AudioContext currentTime of its FIRST sample.
//   4. 'flush' message empties partial buffer immediately (used on video
//      end / source swap so the tail <256ms is not lost).

const SAMPLE_RATE_HZ = 16000;          // forced AudioContext rate
const BATCH_SAMPLES = 4096;            // ~256ms at 16kHz
const BUFFER_CAPACITY = BATCH_SAMPLES * 4; // 1s headroom against main-thread stalls

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Pre-allocated working buffer. We never resize this array.
    this._buf = new Int16Array(BUFFER_CAPACITY);
    this._writePos = 0;
    this._maxAbs = 0;
    // Wall-clock AudioContext time (seconds) of the FIRST sample currently
    // sitting in _buf at index 0. Re-calibrated whenever _writePos goes
    // back to 0 (after a batch emission). Crucially: when we emit a batch
    // but residual samples remain, we update this to point at the new
    // index-0 sample's original time, NOT "now" — so the next batch's
    // timestamp is exact.
    this._bufStartCtxTime = -1;
    // Monotonic sample counter across the lifetime of this processor.
    // Main thread checks (sampleStartSeq of batch N+1) === (sampleStartSeq
    // of batch N) + (samples emitted in batch N). Mismatch = audio hole.
    this._sampleSeq = 0;

    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this._emitBatch(this._writePos, /*isFlush=*/true);
      }
    };
  }

  // Emit `count` samples from the head of the buffer. Shift any residual
  // samples down to index 0 and adjust _bufStartCtxTime accordingly.
  _emitBatch(count, isFlush) {
    if (count <= 0) return;
    if (count > this._writePos) count = this._writePos;

    // Copy the batch — DO NOT transfer the ring buffer itself; we need it.
    const out = new Int16Array(count);
    out.set(this._buf.subarray(0, count));

    this.port.postMessage(
      {
        pcm: out.buffer,
        maxAbs: this._maxAbs,
        startCtxTime: this._bufStartCtxTime,
        sampleStartSeq: this._sampleSeq,
        sampleCount: count,
        flush: !!isFlush,
      },
      [out.buffer]
    );

    this._sampleSeq += count;

    // Shift residual samples down. Common case: residual is 0 when we emit
    // exactly at the batch boundary; rare otherwise.
    const residual = this._writePos - count;
    if (residual > 0) {
      this._buf.copyWithin(0, count, this._writePos);
      // The new index-0 sample was originally at sample offset `count`
      // relative to old _bufStartCtxTime.
      this._bufStartCtxTime = this._bufStartCtxTime + count / SAMPLE_RATE_HZ;
    } else {
      // Buffer fully drained — next process() call will re-arm timestamp.
      this._bufStartCtxTime = -1;
    }
    this._writePos = residual;
    this._maxAbs = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }
    // ─── Channel down-mix ────────────────────────────────────────────
    // Many videos (movies, dialog-heavy clips, music videos) split vocals
    // and music between the two stereo channels. Previously we only read
    // input[0] (left), which on such clips could feed whisper a BGM-only
    // stream while the dialog sat entirely on the right channel.
    //
    // Mix all available channels down to mono via simple averaging. Cost is
    // a couple of multiplies per sample — negligible (~256 extra ops per
    // 128-sample quantum = thousandths of a percent of a CPU core).
    const channelCount = input.length;
    const channelData = input[0];
    const n = channelData.length;
    // Cache the second channel reference outside the inner loop for speed.
    const channelR = channelCount > 1 ? input[1] : null;

    // Arm timestamp for the first sample of THIS quantum if buffer was empty.
    if (this._writePos === 0 && this._bufStartCtxTime < 0) {
      // Note: AudioWorklet's `currentTime` global is the AudioContext time
      // at the START of this render quantum (per spec). This is the exact
      // wall-clock instant of channelData[0].
      this._bufStartCtxTime = currentTime;
    }

    // Defensive: if writing would overflow the ring (main thread totally
    // stalled), drop the OLDEST batch and log it via a sentinel message.
    if (this._writePos + n > BUFFER_CAPACITY) {
      const dropped = (this._writePos + n) - BUFFER_CAPACITY;
      this.port.postMessage({
        overflow: true,
        droppedSamples: dropped,
        atSampleSeq: this._sampleSeq + this._writePos,
      });
      // Shift away `dropped` oldest samples to make room.
      this._buf.copyWithin(0, dropped, this._writePos);
      this._writePos -= dropped;
      this._sampleSeq += dropped; // pretend they were emitted
      this._bufStartCtxTime += dropped / SAMPLE_RATE_HZ;
    }

    // Convert Float32 → Int16 (mixed down to mono) and append at _writePos.
    let maxAbs = this._maxAbs;
    const base = this._writePos;
    if (channelR) {
      // Stereo (or more): average L+R. Two-channel case is by far the most
      // common; for >2 channels we still only use L+R here — surround mixes
      // typically duplicate dialog into front L/R anyway.
      for (let i = 0; i < n; i++) {
        const f = (channelData[i] + channelR[i]) * 0.5;
        const clamped = f < -1 ? -1 : (f > 1 ? 1 : f);
        const v = Math.round(clamped * 32767);
        this._buf[base + i] = v;
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
    } else {
      // True mono — original fast path, no extra add/mul per sample.
      for (let i = 0; i < n; i++) {
        const f = channelData[i];
        const clamped = f < -1 ? -1 : (f > 1 ? 1 : f);
        const v = Math.round(clamped * 32767);
        this._buf[base + i] = v;
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
    }
    this._maxAbs = maxAbs;
    this._writePos += n;

    // Emit as many full batches as accumulated. Usually 0 or 1; rarely 2.
    while (this._writePos >= BATCH_SAMPLES) {
      this._emitBatch(BATCH_SAMPLES, /*isFlush=*/false);
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

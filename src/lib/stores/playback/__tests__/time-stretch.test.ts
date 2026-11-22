import { describe, expect, it, vi } from "vite-plus/test";
import { SoundTouch } from "@soundtouchjs/core";
import { concatTrim, LANCZOS_TABLE_STRATEGY, TimeStretcher } from "../time-stretch";

// The real SoundTouch, recording the options each instance was built with.
const { soundTouchOptions } = vi.hoisted(() => ({
  soundTouchOptions: new Array<ConstructorParameters<typeof SoundTouch>[0]>()
}));
vi.mock("@soundtouchjs/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@soundtouchjs/core")>();
  class RecordingSoundTouch extends actual.SoundTouch {
    constructor(options?: ConstructorParameters<typeof actual.SoundTouch>[0]) {
      super(options);
      soundTouchOptions.push(options);
    }
  }
  return { ...actual, SoundTouch: RecordingSoundTouch };
});

const SAMPLE_RATE = 24000;

function sine(frames: number, hz: number): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return samples;
}

/** Zero crossings per second, a cheap stand-in for perceived pitch on a sine. */
function crossingsPerSecond(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  }
  return (crossings * SAMPLE_RATE) / samples.length;
}

/** Push a whole signal through in chunks, flush, and return the joined output. */
function render(
  input: Float32Array<ArrayBuffer>,
  speed: number,
  pitch: number,
  chunkFrames = 4800
): Float32Array {
  const stretcher = new TimeStretcher(SAMPLE_RATE, 1);
  stretcher.setRate(speed, pitch);
  const parts: Float32Array[] = [];
  for (let offset = 0; offset < input.length; offset += chunkFrames) {
    const output = stretcher.push([input.slice(offset, offset + chunkFrames)]);
    if (output) parts.push(output[0]);
  }
  const tail = stretcher.flush();
  if (tail) parts.push(tail[0]);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Float32Array(total);
  let written = 0;
  for (const part of parts) {
    joined.set(part, written);
    written += part.length;
  }
  return joined;
}

/**
 * Voiced worst case for WSOLA matching: gliding f0 with vibrato and 15
 * harmonics, so any splice lands mid-waveform instead of on a zero crossing.
 */
function voiced(frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const f0 = 145 + 35 * Math.sin(2 * Math.PI * 0.21 * t) + 4 * Math.sin(2 * Math.PI * 6 * t);
    phase += (2 * Math.PI * f0) / SAMPLE_RATE;
    let volume = 0;
    for (let h = 1; h <= 15; h++) volume += Math.sin(phase * h) / h;
    out[i] = 0.3 * volume;
  }
  return out;
}

const VOICED_THREE_FRAGMENTS = voiced(1.5 * SAMPLE_RATE);

/** Largest per-sample step, restricted to (or, with `exclude`, away from) a window around each seam. */
function maxDeltaNearSeams(
  samples: Float32Array,
  seams: number[],
  window: number,
  exclude = false
): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    if (seams.some((seam) => Math.abs(i - seam) <= window) === exclude) continue;
    max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
  }
  return max;
}

describe("TimeStretcher", () => {
  it("passes audio through untouched at speed 1 and pitch 1", () => {
    const input = sine(SAMPLE_RATE, 440);
    const stretcher = new TimeStretcher(SAMPLE_RATE, 1);
    expect(stretcher.isBypassed).toBe(true);
    expect(stretcher.push([input])?.[0]).toBe(input);
    expect(stretcher.flush()).toBeNull();
  });

  // Pins the `pitch` setter + `stretch.tempo` override: SoundTouch derives
  // tempo = 1 / pitch from the setter, and we replace it with speed / pitch.
  it.each([
    [0.5, 1],
    [1.5, 1],
    [1, 0.75],
    [2, 1.35]
  ])("applies speed %s and pitch %s independently", (speed, pitch) => {
    const input = sine(2 * SAMPLE_RATE, 440);
    const output = render(input, speed, pitch);
    expect(output.length / (input.length / speed)).toBeCloseTo(1, 1);
    expect(crossingsPerSecond(output)).toBeCloseTo(880 * pitch, -2);
  });

  it("keeps stereo channels aligned", () => {
    const stretcher = new TimeStretcher(SAMPLE_RATE, 2);
    stretcher.setRate(1.5, 1);
    const left = sine(SAMPLE_RATE, 440);
    const right = sine(SAMPLE_RATE, 220);
    const output = stretcher.push([left, right]);
    expect(output).not.toBeNull();
    expect(output![0].length).toBe(output![1].length);
    expect(crossingsPerSecond(output![0])).toBeCloseTo(880, -2);
    expect(crossingsPerSecond(output![1])).toBeCloseTo(440, -2);
  });

  it("drops nothing but silence when flushing a fragment tail", () => {
    const input = sine(SAMPLE_RATE, 440);
    const stretcher = new TimeStretcher(SAMPLE_RATE, 1);
    stretcher.setRate(1.25, 1);
    const body = stretcher.push([input])?.[0].length ?? 0;
    const tail = stretcher.flush()?.[0].length ?? 0;
    // Flush pads with silence but is capped at the frames the input is owed.
    expect(body + tail).toBeLessThanOrEqual(Math.round(input.length / 1.25));
    expect(body + tail).toBeGreaterThan(input.length / 1.25 - 0.05 * SAMPLE_RATE);
  });

  // Flush resets SoundTouch between fragments; without the fades the next
  // fragment's first sample lands at full amplitude in one step while the
  // flushed tail splices mid-waveform. Both showed up as per-sample steps well
  // above the signal's natural slew, audible as scattered ticks.
  it.each([
    [1.35, 1.15],
    [1.25, 1.0]
  ])(
    "keeps fragment seams as smooth as the surrounding audio (speed %s, pitch %s)",
    (speed, pitch) => {
      const input = VOICED_THREE_FRAGMENTS;
      const fragmentFrames = 0.5 * SAMPLE_RATE;
      const chunkFrames = 2048;
      const stretcher = new TimeStretcher(SAMPLE_RATE, 1);
      stretcher.setRate(speed, pitch);
      const parts: Float32Array[] = [];
      const seams: number[] = [];
      let total = 0;
      for (let start = 0; start < input.length; start += fragmentFrames) {
        const end = Math.min(start + fragmentFrames, input.length);
        for (let offset = start; offset < end; offset += chunkFrames) {
          const output = stretcher.push([input.slice(offset, Math.min(offset + chunkFrames, end))]);
          if (output) {
            parts.push(output[0]);
            total += output[0].length;
          }
        }
        const tail = stretcher.flush();
        if (tail) {
          parts.push(tail[0]);
          total += tail[0].length;
        }
        if (end < input.length) seams.push(total);
      }
      const joined = new Float32Array(total);
      let written = 0;
      for (const part of parts) {
        joined.set(part, written);
        written += part.length;
      }

      // Reference is the same stretched audio away from the seams - the signal's
      // natural per-sample slew. 15 ms covers the flushed-tail splice and the
      // next fragment's post-seam onset.
      const window = Math.round(0.015 * SAMPLE_RATE);
      const nearSeams = maxDeltaNearSeams(joined, seams, window);
      const elsewhere = maxDeltaNearSeams(joined, seams, window, true);
      expect(seams.length).toBe(2);
      expect(nearSeams).toBeLessThanOrEqual(elsewhere);
    }
  );
});

describe("table-driven Lanczos transposer", () => {
  /** Pitch-shift an interleaved stereo signal in blocks, so every block edge is exercised. */
  function transpose(strategy: string, interleaved: Float32Array, blockFrames: number) {
    const processor = new SoundTouch({
      sampleRate: SAMPLE_RATE,
      sampleBufferType: "fifo",
      interpolationStrategy: strategy
    });
    processor.pitch = 0.85;
    const parts: Float32Array[] = [];
    for (let offset = 0; offset < interleaved.length; offset += blockFrames * 2) {
      processor.inputBuffer.putSamples(interleaved.slice(offset, offset + blockFrames * 2));
      processor.process();
      const frames = processor.outputBuffer.frameCount;
      const out = new Float32Array(frames * 2);
      processor.outputBuffer.extract(out, 0, frames);
      processor.outputBuffer.receive(frames);
      parts.push(out);
    }
    const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  }

  it("matches SoundTouch's built-in Lanczos output", () => {
    const left = sine(SAMPLE_RATE, 220);
    const right = sine(SAMPLE_RATE, 330);
    const interleaved = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[2 * i] = left[i];
      interleaved[2 * i + 1] = right[i];
    }
    const reference = transpose("lanczos", interleaved, 1777);
    const table = transpose(LANCZOS_TABLE_STRATEGY, interleaved, 1777);

    expect(table.length).toBe(reference.length);
    let noise = 0;
    let signal = 0;
    for (let i = 0; i < reference.length; i++) {
      noise += (table[i] - reference[i]) ** 2;
      signal += reference[i] ** 2;
    }
    expect(10 * Math.log10(signal / noise)).toBeGreaterThan(70);
  });

  it("is the transposer every TimeStretcher uses", () => {
    soundTouchOptions.length = 0;
    new TimeStretcher(SAMPLE_RATE, 1);
    expect(soundTouchOptions).toEqual([
      expect.objectContaining({ interpolationStrategy: LANCZOS_TABLE_STRATEGY })
    ]);
  });
});

describe("concatTrim", () => {
  it("truncates overflow and leaves shortfall silent", () => {
    const parts = [[Float32Array.of(1, 2, 3)], null, [Float32Array.of(4, 5)]];
    expect(Array.from(concatTrim(parts, 4, 1)[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(concatTrim(parts, 7, 1)[0])).toEqual([1, 2, 3, 4, 5, 0, 0]);
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PcmStreamScheduler, type StreamChunkPayload } from "../pcm-stream";

interface RecordedBuffer {
  duration: number;
  samples: Float32Array[];
}

interface RecordedSource {
  buffer: RecordedBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  start: (at: number, offset?: number) => void;
  stop: () => void;
  connect: () => void;
  at: number;
  offset: number;
}

function createHarness() {
  const sources: RecordedSource[] = [];
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: {},
    resume: () => {},
    suspend: () => {},
    createGain: () => ({
      gain: { value: 1 },
      connect: () => {},
      disconnect: () => {}
    }),
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const samples = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        duration: length / sampleRate,
        samples,
        copyToChannel: (data: Float32Array, channel: number) => samples[channel].set(data)
      };
    },
    createBufferSource: () => {
      const source: RecordedSource = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        at: 0,
        offset: 0,
        start: (at, offset = 0) => {
          source.at = at;
          source.offset = offset;
          sources.push(source);
        },
        stop: () => {},
        connect: () => {}
      };
      return source;
    }
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return ctx;
    })
  );
  const audioContext = new AudioContext();
  const onComplete = vi.fn();
  const scheduler = new PcmStreamScheduler({
    ctx: audioContext,
    destination: audioContext.destination,
    onComplete
  });
  return { scheduler, sources, ctx, onComplete };
}

function chunk(bytes: Uint8Array, channels = 1, isFinal = false): StreamChunkPayload {
  return {
    audio_base64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
    sample_rate: 24000,
    channels,
    bits_per_sample: 16,
    fragment_index: 0,
    fragment_total: 1,
    is_final: isFinal
  };
}

const SILENT_1S_BASE64 = btoa("\0".repeat(48000));

function silentChunk(fragmentIndex = 0, isFinal = false): StreamChunkPayload {
  return {
    audio_base64: SILENT_1S_BASE64,
    sample_rate: 24000,
    channels: 1,
    bits_per_sample: 16,
    fragment_index: fragmentIndex,
    fragment_total: 1,
    is_final: isFinal
  };
}

function pcmBytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function renderedChannel(sources: RecordedSource[], channel: number): number[] {
  return sources.flatMap((source) => Array.from(source.buffer?.samples[channel] ?? []));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PcmStreamScheduler", () => {
  it("reports the audible fragment and freezes its clock through pause and underruns", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    expect(scheduler.getPlaybackPosition()).toBeNull();
    ctx.currentTime = 0.53;
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(500);
    // Suspended AudioContexts keep the same currentTime, even as wall time passes.
    ctx.state = "suspended";
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(500);
    ctx.state = "running";
    ctx.currentTime = 1.28;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(1);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(250);
    ctx.currentTime = 2.1;
    sources.forEach((source) => source.onended?.());
    expect(scheduler.getPlaybackPosition()).toBeNull();
    scheduler.stop();
    expect(scheduler.getPlaybackPosition()).toBeNull();
  });

  it("reports the position reaching the speakers, behind currentTime by outputLatency", () => {
    const { scheduler, sources, ctx } = createHarness();
    Object.assign(ctx, { outputLatency: 0.2 });
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    ctx.currentTime = 0.53;
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(300);
    // Fragment 0 has ended on the context clock but is still in the output pipeline.
    ctx.currentTime = 1.13;
    sources.filter((source) => source.at < 1).forEach((source) => source.onended?.());
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(0);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(900);
    ctx.currentTime = 1.33;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(1);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(100);
    scheduler.stop();
  });

  it("keeps audible audio at the rate it was rendered at", () => {
    const { scheduler, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    ctx.currentTime = 0.28;
    scheduler.setRate(2, 1);
    // The audible source was time-stretched at speed 1 and cannot be retuned in
    // place, so its clock keeps advancing one native second per wall second.
    ctx.currentTime = 0.53;
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(500);
    scheduler.stop();
  });

  it.each([0.5, 2])("reschedules future fragments without gaps or overlap at rate %s", (rate) => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    const oldFuture = sources[1];
    oldFuture.stop = vi.fn();
    ctx.currentTime = 0.53;
    scheduler.setRate(rate, 1);
    const expectedStart = 1.03;
    expect(oldFuture.stop).toHaveBeenCalledOnce();
    expect(oldFuture.onended).toBeNull();
    expect(sources[2].at).toBeCloseTo(expectedStart);
    expect(sources[2].buffer!.duration).toBeGreaterThan(0.75 / rate);
    expect(sources[2].buffer!.duration).toBeLessThanOrEqual(1.02 / rate);
    ctx.currentTime = expectedStart + 0.1;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(1);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(100 * rate);
    scheduler.stop();
  });

  it("flushes a short intermediate fragment without completing the queue", () => {
    const { scheduler, sources, onComplete } = createHarness();
    scheduler.handleChunk(chunk(new Uint8Array(2400)));
    expect(sources).toHaveLength(0);
    scheduler.handleChunk({ ...chunk(new Uint8Array()), fragment_duration_ms: 50 });
    expect(sources).toHaveLength(1);
    sources[0].onended?.();
    expect(onComplete).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it.each([1, 2])("preserves PCM samples across every byte split with %i channels", (channels) => {
    const samples = [0x1234, -0x1234, 32767, -32768, 1, -1, 8192, -8192];
    const bytes = pcmBytes(samples);
    for (let split = 1; split < bytes.length; split++) {
      const { scheduler, sources } = createHarness();
      scheduler.handleChunk(chunk(bytes.subarray(0, split), channels));
      scheduler.handleChunk(chunk(bytes.subarray(split), channels));
      scheduler.handleChunk(chunk(new Uint8Array(), channels, true));
      scheduler.markQueueComplete();
      for (let channel = 0; channel < channels; channel++) {
        expect(renderedChannel(sources, channel), `split=${split}, channel=${channel}`).toEqual(
          samples.filter((_, index) => index % channels === channel).map((sample) => sample / 32768)
        );
      }
      scheduler.stop();
    }
    if (channels === 2) {
      const { scheduler, sources } = createHarness();
      for (const byte of pcmBytes([1234, -2345, 3456, -4567])) {
        scheduler.handleChunk(chunk(Uint8Array.of(byte), 2));
      }
      scheduler.handleChunk(chunk(new Uint8Array(), 2, true));
      scheduler.markQueueComplete();
      expect(renderedChannel(sources, 0)).toEqual([1234 / 32768, 3456 / 32768]);
      expect(renderedChannel(sources, 1)).toEqual([-2345 / 32768, -4567 / 32768]);
      scheduler.stop();
    }
  });

  it("starts before the terminal marker and schedules jittered chunks contiguously", () => {
    const { scheduler, sources, ctx, onComplete } = createHarness();
    const samples = Array.from({ length: 9600 }, (_, index) => (index % 32768) - 16384);
    const bytes = pcmBytes(samples);
    const arrivals = [
      { end: 4001, time: 0 },
      { end: 9000, time: 0.08 },
      { end: 14001, time: 0.15 },
      { end: bytes.length, time: 0.27 }
    ];
    let offset = 0;
    for (const { end, time } of arrivals) {
      ctx.currentTime = time;
      scheduler.handleChunk(chunk(bytes.subarray(offset, end)));
      offset = end;
    }
    expect(renderedChannel(sources, 0)).toEqual(samples.map((sample) => sample / 32768));
    expect(sources[0].at).toBeCloseTo(0.11);
    for (let index = 1; index < sources.length; index++) {
      const previous = sources[index - 1];
      expect(sources[index].at).toBeCloseTo(previous.at + (previous.buffer?.duration ?? 0));
    }
    const audioSources = [...sources];
    scheduler.handleChunk(chunk(new Uint8Array(), 1, true));
    scheduler.markQueueComplete();
    expect(sources).toEqual(audioSources);
    expect(onComplete).not.toHaveBeenCalled();
    for (const source of sources) source.onended?.();
    expect(onComplete).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("discards a truncated terminal frame rather than leaking it into the next fragment", () => {
    const { scheduler, sources } = createHarness();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scheduler.handleChunk(chunk(Uint8Array.of(0xff)));
    scheduler.handleChunk(chunk(new Uint8Array(), 1, true));
    scheduler.handleChunk({ ...chunk(pcmBytes([0x1234, -0x1234])), fragment_index: 1 });
    scheduler.handleChunk({ ...chunk(new Uint8Array(), 1, true), fragment_index: 1 });
    scheduler.markQueueComplete();
    expect(renderedChannel(sources, 0)).toEqual([0x1234 / 32768, -0x1234 / 32768]);
    scheduler.stop();
  });

  it("completes an empty terminal stream without scheduling audio", () => {
    const { scheduler, sources, onComplete } = createHarness();
    scheduler.handleChunk(chunk(new Uint8Array(), 1, true));
    scheduler.markQueueComplete();
    expect(sources).toEqual([]);
    expect(onComplete).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("completes on the terminal marker itself, without the 2s idle fallback", () => {
    const { scheduler, sources, onComplete } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(chunk(new Uint8Array(), 1, true));
    for (const source of sources) source.onended?.();
    expect(onComplete).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("rewinds through retained history and keeps fragment positions exact", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    expect(sources).toHaveLength(2);
    ctx.currentTime = 1.5;
    sources[0].onended?.();
    scheduler.skipBackward(0.8);
    expect(sources).toHaveLength(4);
    expect(sources[2].at).toBeCloseTo(1.53);
    expect(sources[2].offset).toBeCloseTo(0.67);
    expect(sources[3].at).toBeCloseTo(1.86);
    expect(sources[3].offset).toBeCloseTo(0);
    expect(sources[1].onended).toBeNull();
    ctx.currentTime = 1.53;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(0);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(670);
    scheduler.stop();
  });

  it("fast-forwards through scheduled audio and remaps the captions", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    ctx.currentTime = 0.5;
    scheduler.skipForward(0.8);
    expect(sources).toHaveLength(3);
    expect(sources[2].at).toBeCloseTo(0.53);
    expect(sources[2].offset).toBeCloseTo(0.27);
    expect(sources[0].onended).toBeNull();
    expect(sources[1].onended).toBeNull();
    ctx.currentTime = 0.53;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(1);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(270);
    scheduler.stop();
  });

  it("rewinding after a fast-forward returns to the pre-skip content", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk(silentChunk(1));
    ctx.currentTime = 0.5;
    scheduler.skipForward(0.8);
    ctx.currentTime = 0.55;
    scheduler.skipBackward(0.8);
    expect(sources[3].at).toBeCloseTo(0.58);
    expect(sources[3].offset).toBeCloseTo(0.49);
    ctx.currentTime = 0.59;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(0);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(500);
    scheduler.stop();
  });

  it("banks fast-forward overshoot as debt and drops arriving audio with it", () => {
    const { scheduler, sources, ctx, onComplete } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    ctx.currentTime = 0.5;
    scheduler.skipForward(2.5);
    expect(sources).toHaveLength(1);
    scheduler.handleChunk(silentChunk(1));
    expect(sources).toHaveLength(1);
    scheduler.handleChunk(silentChunk(1));
    expect(sources).toHaveLength(2);
    expect(sources[1].buffer!.duration).toBeCloseTo(0.03);
    ctx.currentTime = 0.54;
    expect(scheduler.getPlaybackPosition()?.fragmentIndex).toBe(1);
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(1980, 1);
    scheduler.handleChunk(chunk(new Uint8Array(), 1, true));
    expect(onComplete).not.toHaveBeenCalled();
    sources.at(-1)!.onended?.();
    expect(onComplete).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("skips while the context is suspended and resumes into the rebuilt timeline", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    ctx.state = "suspended";
    ctx.currentTime = 0.5;
    scheduler.skipBackward(0.2);
    expect(sources).toHaveLength(2);
    expect(sources[1].at).toBeCloseTo(0.53);
    expect(sources[1].offset).toBeCloseTo(0.27);
    scheduler.stop();
  });

  it("ignores skips before anything has been scheduled and banks forward debt", () => {
    const { scheduler, sources } = createHarness();
    scheduler.skipBackward(5);
    expect(sources).toHaveLength(0);
    scheduler.skipForward(5);
    expect(sources).toHaveLength(0);
    for (let i = 0; i < 5; i++) scheduler.handleChunk(silentChunk(0));
    expect(sources).toHaveLength(0);
    scheduler.handleChunk(silentChunk(0));
    expect(sources).toHaveLength(1);
    expect(sources[0].buffer!.duration).toBeCloseTo(1);
    scheduler.stop();
  });

  it("keeps only ~30s of rewind history and clamps to its earliest span", () => {
    const { scheduler, sources, ctx } = createHarness();
    for (let i = 0; i < 31; i++) scheduler.handleChunk(silentChunk(0));
    ctx.currentTime = 2.2;
    scheduler.handleChunk(silentChunk(0));
    scheduler.skipBackward(1000);
    expect(sources[32].at).toBeCloseTo(2.23);
    expect(sources[32].offset).toBeCloseTo(0);
    ctx.currentTime = 2.23;
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(2000);
    scheduler.stop();
  });

  it("skips wall seconds at the rendered rate, not native seconds", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.setRate(2, 1);
    scheduler.handleChunk(silentChunk(0));
    ctx.currentTime = 0.3;
    scheduler.skipBackward(0.25);
    expect(sources[1].at).toBeCloseTo(0.33);
    expect(sources[1].offset).toBeCloseTo(0.02);
    ctx.currentTime = 0.34;
    expect(scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(60);
    scheduler.stop();
  });

  it("skips forward and backward from the stalled playhead after scheduled audio drains", () => {
    const forwardHarness = createHarness();
    forwardHarness.scheduler.handleChunk(silentChunk(0));
    forwardHarness.ctx.currentTime = 1.5;
    forwardHarness.sources[0].onended?.();
    forwardHarness.scheduler.getPlaybackPosition();
    forwardHarness.scheduler.skipForward(5);
    expect(forwardHarness.sources).toHaveLength(1);
    for (let i = 0; i < 5; i++) forwardHarness.scheduler.handleChunk(silentChunk(1));
    expect(forwardHarness.sources).toHaveLength(1);
    forwardHarness.scheduler.handleChunk(silentChunk(1));
    expect(forwardHarness.sources).toHaveLength(2);
    forwardHarness.scheduler.stop();

    const backwardHarness = createHarness();
    backwardHarness.scheduler.handleChunk(silentChunk(0));
    backwardHarness.ctx.currentTime = 1.5;
    backwardHarness.sources[0].onended?.();
    backwardHarness.scheduler.getPlaybackPosition();
    backwardHarness.scheduler.skipBackward(0.3);
    expect(backwardHarness.sources).toHaveLength(2);
    expect(backwardHarness.sources[1].at).toBeCloseTo(1.53);
    expect(backwardHarness.sources[1].offset).toBeCloseTo(0.7);
    backwardHarness.ctx.currentTime = 1.55;
    expect(backwardHarness.scheduler.getPlaybackPosition()?.positionMs).toBeCloseTo(720);
    backwardHarness.scheduler.stop();
  });

  it("keeps a rapid second skip anchored during the rebuild's start delay", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.handleChunk(silentChunk(0));
    ctx.currentTime = 0.5;
    scheduler.skipBackward(0.2);
    expect(sources[1].at).toBeCloseTo(0.53);
    expect(sources[1].offset).toBeCloseTo(0.27);
    scheduler.skipBackward(0.2);
    expect(sources[2].at).toBeCloseTo(0.53);
    expect(sources[2].offset).toBeCloseTo(0.07);
    scheduler.stop();
  });

  it("consumes fast-forward debt in wall seconds at the rendered rate", () => {
    const { scheduler, sources, ctx } = createHarness();
    scheduler.setRate(2, 1);
    scheduler.handleChunk(silentChunk(0));
    scheduler.handleChunk({ ...chunk(new Uint8Array()), fragment_duration_ms: 500 });
    ctx.currentTime = 0.05;
    scheduler.skipForward(1);
    scheduler.handleChunk(silentChunk(1));
    expect(sources).toHaveLength(2);
    scheduler.handleChunk(silentChunk(1));
    expect(sources).toHaveLength(3);
    ctx.currentTime = sources[2].at + 0.01;
    const position = scheduler.getPlaybackPosition();
    expect(position?.fragmentIndex).toBe(1);
    expect(position?.positionMs).toBeCloseTo(1060, 0);
    scheduler.stop();
  });
});

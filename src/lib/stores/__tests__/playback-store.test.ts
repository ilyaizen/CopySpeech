// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "svelte-sonner";
import { playbackStore } from "../playback-store.svelte";
import { testConfig } from "#lib/test-fixtures/app-config.js";
import { PcmStreamScheduler, type StreamChunkPayload } from "../playback/pcm-stream";
import type { AnalyserConfig } from "../playback/analyser.js";

const { listeners, live, ipc, analyserConfigs } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => Promise<void>>(),
  // Config each `AudioAnalyser.setup` received, newest last.
  analyserConfigs: new Array<AnalyserConfig>(),
  // Every registration not yet unlistened, including ones the Map overwrote.
  live: new Set<unknown>(),
  // Every `listen` waits on this, so a test can hold setup mid-registration.
  ipc: { ready: Promise.resolve() }
}));
vi.mock("#lib/services/tauri.js", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    await ipc.ready;
    listeners.set(name, callback);
    live.add(callback);
    return () => {
      listeners.delete(name);
      live.delete(callback);
    };
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {})
}));
vi.mock("../playback/analyser.js", () => ({
  AudioAnalyser: class {
    getAnalyser() {
      return null;
    }
    setup(_audio: HTMLAudioElement, _context: AudioContext, config: AnalyserConfig) {
      analyserConfigs.push(config);
    }
    start() {}
    stop() {}
    destroy() {}
  }
}));

const decode = vi.fn(async () => ({ duration: 1 }));
let audio: HTMLAudioElement;
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  decode.mockReset().mockResolvedValue({ duration: 1 });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      decodeAudioData = decode;
      close = vi.fn();
    }
  );
  audio = document.createElement("audio");
  pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});
  playSpy = vi.spyOn(audio, "play").mockImplementation(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  vi.spyOn(playbackStore, "buildPlaybackUrl").mockResolvedValue("blob:history-audio");
  playbackStore.setAudioElement(audio);
  playbackStore.syncPlaybackConfig(100, 1, 1);
  playbackStore.setHudEnabled(true);
  playbackStore.historyReadingId = "batch:reading";
  await playbackStore.setupListeners();
});

afterEach(() => {
  playbackStore.teardownListeners();
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  playbackStore.setAudioElement(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The store is a module singleton and a fake-timer test advances Date.now, so
  // the 100 ms caption-report throttle can sit in the future after that test.
  // A later real-clock test would then wait for a report that cannot arrive.
  Reflect.set(playbackStore, "_lastCaptionReport", 0);
});

async function sendAudio(index?: number, sessionId?: string, total = 2) {
  const name = index === undefined ? "audio-ready" : "audio-fragment-ready";
  await listeners.get(name)!({
    payload:
      index === undefined
        ? "YQ=="
        : {
            audio_base64: "YQ==",
            fragment_index: index,
            fragment_total: total,
            is_final: index === total - 1,
            text: `Part ${index}`,
            session_id: sessionId ?? null
          }
  });
}

it.each(["decode", "play"])(
  "releases the queue after a %s failure so history can retry",
  async (failure) => {
    if (failure === "decode") decode.mockRejectedValueOnce(new Error("broken audio"));
    else playSpy.mockRejectedValueOnce(new Error("play rejected"));
    await sendAudio();
    expect(playbackStore.error).toContain("Audio playback failed");
    expect(playbackStore.isLoadingAudio).toBe(false);
    expect(playbackStore.isPlaying).toBe(false);
    await sendAudio();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(playbackStore.isPlaying).toBe(true);
    expect(playbackStore.error).toBeNull();
  }
);

it("keeps one set of listeners when HMR tears GlobalPlayer down mid-setup", async () => {
  const perSetup = live.size;
  playbackStore.teardownListeners();

  const ready = Promise.withResolvers<void>();
  ipc.ready = ready.promise;
  vi.mocked(listen).mockClear();
  const first = playbackStore.setupListeners();
  await vi.waitFor(() => expect(listen).toHaveBeenCalled());
  playbackStore.teardownListeners();
  const second = playbackStore.setupListeners();
  ready.resolve();
  ipc.ready = Promise.resolve();
  await Promise.all([first, second]);

  expect(live.size).toBe(perSetup);
});

it("does not restart a stopped reading when its pending decode finishes", async () => {
  const pending = Promise.withResolvers<{ duration: number }>();
  decode.mockReturnValueOnce(pending.promise);
  const first = sendAudio(0);
  expect(playbackStore.isLoadingAudio).toBe(true);
  playbackStore.handleStop();
  pending.resolve({ duration: 1 });
  await first;
  expect(playSpy).not.toHaveBeenCalled();
  expect(playbackStore.isLoadingAudio).toBe(false);
  await sendAudio(0);
  expect(playSpy).toHaveBeenCalledTimes(1);
});

it("emits playback-finished when a reading ends and when it is stopped", async () => {
  await sendAudio();
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null })
  );
  vi.mocked(emit).mockClear();
  playbackStore.handleStop();
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null });
});

it("reports an incomplete reading and clears it when the next reading starts", async () => {
  await listeners.get("synthesis-state-change")!({ payload: true });
  await sendAudio(0);
  await sendAudio(1);
  const message =
    "Reading stopped: section 3 of 5 failed, so the rest of the passage was not read. HTTP 503";
  await listeners.get("reading-failed")!({ payload: { message } });
  expect(playbackStore.error).toBe(message);
  expect(toast.error).toHaveBeenCalledWith(message, { duration: 15000 });
  await listeners.get("synthesis-state-change")!({ payload: true });
  expect(playbackStore.error).toBeNull();
});

it("warns about clipboard truncation independently of the active route", async () => {
  await listeners.get("text-truncated")!({
    payload: { original_length: 120000, truncated_length: 99999, max_length: 100000 }
  });
  expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("120000 to 99999"), {
    duration: 15000
  });
});

it("does not label a failed browser reading completed when its audio drains", async () => {
  await listeners.get("synthesis-state-change")!({ payload: true });
  await sendAudio(0, "b1");
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  await listeners.get("reading-failed")!({
    payload: {
      message: "Reading stopped: section 2 of 5 failed, so the rest of the passage was not read."
    }
  });
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("browser_reading_finished", {
      sessionId: "b1",
      status: "error"
    })
  );
});

it("releases a reading waiting for its next fragment when the section failure lands", async () => {
  vi.mocked(emit).mockClear();
  await sendAudio(0);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  audio.dispatchEvent(new Event("ended"));
  expect(emit).not.toHaveBeenCalledWith("playback-finished", { reading_id: null });
  await listeners.get("reading-failed")!({
    payload: {
      message: "Reading stopped: section 2 of 5 failed, so the rest of the passage was not read."
    }
  });
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null })
  );
});

it("replays the rendered audio, not a previous reading's fragments, once a new reading starts", async () => {
  await sendAudio(0);
  await sendAudio(1);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  audio.dispatchEvent(new Event("ended"));
  await listeners.get("synthesis-state-change")!({ payload: true });
  await playbackStore.handleReplay();
  expect(playbackStore.currentFragmentIndex).toBeNull();
  expect(playSpy).toHaveBeenCalledTimes(3);
});

it("releases a queued reading when the bridge cancels its session", async () => {
  vi.mocked(emit).mockClear();
  await sendAudio(0, "trigger-a");
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  audio.dispatchEvent(new Event("ended"));
  expect(emit).not.toHaveBeenCalledWith("playback-finished", { reading_id: null });
  await listeners.get("browser-reading")!({
    payload: { active: false, session_id: "trigger-a" }
  });
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null })
  );
});

it("plays grouped fragments in order, announces each audible fragment, and replays from the beginning", async () => {
  vi.mocked(emit).mockClear();
  await sendAudio(0);
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith("playback-fragment-audible", { index: 0, text: "Part 0" })
  );
  expect(playbackStore.currentFragmentIndex).toBe(0);
  await sendAudio(1);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  expect(playbackStore.currentFragmentIndex).toBe(1);
  audio.dispatchEvent(new Event("ended"));
  expect(playbackStore.isPlaying).toBe(false);
  expect(playbackStore.historyReadingId).toBe("batch:reading");

  await playbackStore.handleReplay();
  expect(playbackStore.currentFragmentIndex).toBe(0);
  expect(playSpy).toHaveBeenCalledTimes(3);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(4));
  expect(playbackStore.currentFragmentIndex).toBe(1);
});

it("publishes captions from the audio clock and audible fragment, then stops publishing on Stop", async () => {
  vi.useFakeTimers();
  vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
  vi.spyOn(audio, "duration", "get").mockReturnValue(1);
  await sendAudio(0);
  await sendAudio(1);
  audio.currentTime = 0.6;
  await vi.advanceTimersByTimeAsync(80);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ text: "Part 0", position_ms: 600, duration_ms: 1000, active: true })
  );
  audio.dispatchEvent(new Event("pause"));
  await vi.advanceTimersByTimeAsync(800);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ position_ms: 600, paused: true })
  );
  playbackStore.handleStop();
  vi.mocked(emitTo).mockClear();
  await vi.advanceTimersByTimeAsync(800);
  expect(emitTo).not.toHaveBeenCalled();
});

it("sends no HUD caption events while the HUD is off, but keeps the Play page and status current", async () => {
  vi.useFakeTimers();
  vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
  vi.spyOn(audio, "duration", "get").mockReturnValue(1);
  const config = testConfig();
  config.hud.enabled = true;
  await sendAudio(0);

  for (const enabled of [false, true, false]) {
    config.general.experimental_enabled = enabled;
    vi.mocked(invoke).mockResolvedValueOnce(config);
    await listeners.get("config-changed")!({ payload: null });
    vi.mocked(emitTo).mockClear();
    vi.mocked(invoke).mockClear();
    audio.currentTime += 0.1;
    await vi.advanceTimersByTimeAsync(100);
    const hudTicks = vi.mocked(emitTo).mock.calls.filter(([, name]) => name === "hud:caption");
    expect(hudTicks).toHaveLength(enabled ? 4 : 0);
    expect(playbackStore.caption).toMatchObject({ text: "Part 0", active: true });
    expect(invoke).toHaveBeenCalledWith("report_playback_caption", {
      caption: playbackStore.caption
    });
  }
});

it("gates the amplitude loop's HUD frames on the HUD flag", async () => {
  await sendAudio(0);
  const gate = analyserConfigs.at(-1)?.hudEnabled;
  expect(gate?.()).toBe(true);

  playbackStore.setHudEnabled(false);
  expect(gate?.()).toBe(false);

  const config = testConfig();
  config.hud.enabled = true;
  config.general.experimental_enabled = true;
  vi.mocked(invoke).mockResolvedValueOnce(config);
  await listeners.get("config-changed")!({ payload: null });
  expect(gate?.()).toBe(true);

  config.general.experimental_enabled = false;
  vi.mocked(invoke).mockResolvedValueOnce(config);
  await listeners.get("config-changed")!({ payload: null });
  expect(gate?.()).toBe(false);
});

it("reports the caption snapshot for the control server, and inactive on stop", async () => {
  vi.useFakeTimers();
  vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
  vi.spyOn(audio, "duration", "get").mockReturnValue(1);
  const reports = () =>
    vi.mocked(invoke).mock.calls.filter(([name]) => name === "report_playback_caption");
  vi.mocked(invoke).mockClear();
  await sendAudio(0);
  audio.currentTime = 0.6;
  await vi.advanceTimersByTimeAsync(120);
  expect(reports()).toContainEqual([
    "report_playback_caption",
    { caption: expect.objectContaining({ text: "Part 0", position_ms: 600, active: true }) }
  ]);
  playbackStore.handleStop();
  expect(reports().at(-1)).toEqual(["report_playback_caption", { caption: { active: false } }]);
  vi.mocked(invoke).mockClear();
  await vi.advanceTimersByTimeAsync(150);
  expect(reports()).toEqual([]);
});

it("delays element captions by the AudioContext output latency in media time", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      outputLatency = 0.2;
      decodeAudioData = decode;
      close = vi.fn();
    }
  );
  vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
  vi.spyOn(audio, "duration", "get").mockReturnValue(1);
  await sendAudio(0);
  audio.playbackRate = 1.5;
  audio.currentTime = 0.6;
  await vi.advanceTimersByTimeAsync(25);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ position_ms: expect.closeTo(300) })
  );
  audio.currentTime = 0.1;
  await vi.advanceTimersByTimeAsync(25);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ position_ms: 0 })
  );
});

it.each([
  [0.5, 500],
  [Number.NaN, 1000]
])(
  "replays native timings through pitch, speed, and pause (duration %s)",
  async (duration, expectedDurationMs) => {
    vi.useFakeTimers();
    vi.spyOn(audio, "readyState", "get").mockReturnValue(4);
    vi.spyOn(audio, "duration", "get").mockReturnValue(duration);
    const captions = {
      text: "Hello world",
      words: [
        { text_start: 0, text_end: 5, start_ms: 100, end_ms: 200 },
        { text_start: 6, text_end: 11, start_ms: 600, end_ms: 800 }
      ]
    };
    playbackStore.syncPlaybackConfig(100, 1.5, 2);
    await listeners.get("audio-fragment-ready")!({
      payload: {
        audio_base64: "YQ==",
        fragment_index: 0,
        fragment_total: 1,
        is_final: true,
        text: "Hello world",
        captions
      }
    });
    audio.currentTime = 0.3;
    playbackStore.syncPlaybackConfig(100, 2, 0.5);
    await vi.advanceTimersByTimeAsync(25);
    expect(emitTo).toHaveBeenLastCalledWith(
      "hud",
      "hud:caption",
      expect.objectContaining({
        captions,
        position_ms: 300,
        duration_ms: expectedDurationMs
      })
    );
    audio.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(100);
    expect(emitTo).toHaveBeenLastCalledWith(
      "hud",
      "hud:caption",
      expect.objectContaining({ captions, position_ms: 300, paused: true })
    );
    playbackStore.syncPlaybackConfig(100, 1, 1);
  }
);

it("keeps streaming captions on the audible fragment and rejects chunks after Stop", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      resume = vi.fn();
      suspend = vi.fn(() => {
        this.state = "suspended";
      });
      close = vi.fn();
    }
  );
  const receive = vi
    .spyOn(PcmStreamScheduler.prototype, "handleChunk")
    .mockImplementation(() => {});
  vi.spyOn(PcmStreamScheduler.prototype, "getPlaybackPosition").mockReturnValue({
    fragmentIndex: 0,
    positionMs: 700
  });
  await listeners.get("synthesis-state-change")!({ payload: true });
  const captions = {
    text: "first",
    words: [{ text_start: 0, text_end: 5, start_ms: 650, end_ms: 800 }]
  };
  const payload = {
    audio_base64: "",
    sample_rate: 24000,
    channels: 1,
    bits_per_sample: 16,
    fragment_index: 0,
    fragment_total: 2,
    is_final: false,
    text: "first",
    captions
  };
  playbackStore.handleStreamChunk(payload);
  playbackStore.handleTogglePause();
  playbackStore.handleStreamChunk({
    ...payload,
    fragment_index: 1,
    text: "second",
    captions: { text: "second", words: [] }
  });
  expect(playbackStore.isPaused).toBe(true);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ text: "first", captions, position_ms: 700, paused: true })
  );
  playbackStore.handleStop();
  receive.mockClear();
  vi.mocked(emitTo).mockClear();
  playbackStore.handleStreamChunk(payload);
  await vi.advanceTimersByTimeAsync(500);
  expect(receive).not.toHaveBeenCalled();
  expect(emitTo).not.toHaveBeenCalled();
});

it("delegates skip and seek deltas to the PCM scheduler while streaming", async () => {
  await startStreamingReading();
  const backward = vi
    .spyOn(PcmStreamScheduler.prototype, "skipBackward")
    .mockImplementation(() => {});
  const forward = vi
    .spyOn(PcmStreamScheduler.prototype, "skipForward")
    .mockImplementation(() => {});
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(playbackStore.isPlaying).toBe(true);
  playbackStore.skipBackward();
  expect(backward).toHaveBeenCalledWith(5);
  playbackStore.skipForward();
  expect(forward).toHaveBeenCalledWith(5);
  playbackStore.seekBy(5000);
  expect(forward).toHaveBeenLastCalledWith(5);
  playbackStore.seekBy(-5000);
  expect(backward).toHaveBeenLastCalledWith(5);
  playbackStore.handleStop();
});

it("rewinds across a fragment boundary through the retained previous fragment", async () => {
  vi.spyOn(audio, "duration", "get").mockReturnValue(2);
  await sendAudio(0);
  await sendAudio(1);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playbackStore.currentFragmentIndex).toBe(1));
  audio.currentTime = 0.5;
  playbackStore.skipBackward(1);
  await vi.waitFor(() => expect(audio.currentTime).toBeCloseTo(1.5));
  expect(playbackStore.currentFragmentIndex).toBe(0);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playbackStore.currentFragmentIndex).toBe(1));
});

it("drives pause, resume, clamped skips and stop from page control events", async () => {
  vi.spyOn(audio, "duration", "get").mockReturnValue(10);
  vi.spyOn(audio, "paused", "get").mockImplementation(() => playbackStore.isPaused);
  await sendAudio();
  expect(playbackStore.isPlaying).toBe(true);
  await listeners.get("playback-toggle-pause")!({ payload: null });
  expect(playbackStore.isPaused).toBe(true);
  await listeners.get("playback-toggle-pause")!({ payload: null });
  expect(playbackStore.isPaused).toBe(false);
  audio.currentTime = 8;
  await listeners.get("playback-skip-forward")!({ payload: null });
  expect(audio.currentTime).toBe(10);
  audio.currentTime = 3;
  await listeners.get("playback-skip-backward")!({ payload: null });
  expect(audio.currentTime).toBe(0);
  await listeners.get("playback-stop")!({ payload: null });
  expect(playbackStore.isPlaying).toBe(false);
});

function streamChunk(sessionId: string | null) {
  return {
    audio_base64: "",
    sample_rate: 24000,
    channels: 1,
    bits_per_sample: 16,
    fragment_index: 0,
    fragment_total: 1,
    is_final: false,
    text: "streamed",
    session_id: sessionId
  };
}

// A new synthesis clears the stop left by the previous reading, as in the app.
async function startStreamingReading() {
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      resume = vi.fn();
      suspend = vi.fn();
      close = vi.fn();
    }
  );
  await listeners.get("synthesis-state-change")!({ payload: true });
}

it("stops only the matching playing stream on id-less playback-stream-failed", async () => {
  await startStreamingReading();
  vi.mocked(emit).mockClear();
  playbackStore.handleStreamChunk(streamChunk("trigger-a"));
  await listeners.get("playback-stream-failed")!({ payload: { session_id: "trigger-b" } });
  expect(playbackStore.isPlaying).toBe(true);
  expect(emit).not.toHaveBeenCalledWith("playback-finished", { reading_id: null });

  await listeners.get("playback-stream-failed")!({ payload: { session_id: "trigger-a" } });
  expect(playbackStore.isPlaying).toBe(false);
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null });
});

it("finishes an idle failed stream only when no active synthesis is running", async () => {
  vi.mocked(emit).mockClear();
  await listeners.get("playback-stream-failed")!({ payload: { session_id: null } });
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: null });

  await startStreamingReading();
  await listeners.get("playback-stream-failed")!({ payload: { session_id: "trigger-a" } });
  playbackStore.handleStreamChunk(streamChunk("trigger-b"));
  expect(playbackStore.isPlaying).toBe(true);
  playbackStore.handleStop();
});

it("reports a followed page session by id, and only the current one", async () => {
  const calls = () => vi.mocked(invoke).mock.calls;
  vi.mocked(invoke).mockClear();
  await sendAudio(0, "trigger-1", 1);
  expect(calls()).toContainEqual([
    "browser_reading_progress",
    expect.objectContaining({ sessionId: "trigger-1", fragmentIndex: 0 })
  ]);
  playbackStore.handleStop();
  expect(calls()).toContainEqual([
    "browser_reading_finished",
    { sessionId: "trigger-1", status: "cancelled" }
  ]);

  vi.mocked(invoke).mockClear();
  await sendAudio(0, "b", 1);
  await listeners.get("browser-reading")!({ payload: { active: false, session_id: "a" } });
  audio.dispatchEvent(new Event("ended"));
  expect(calls()).toContainEqual([
    "browser_reading_finished",
    { sessionId: "b", status: "completed" }
  ]);
});

it("keeps following a queued trigger after the earlier clip drains, once its audio arrives", async () => {
  const calls = () => vi.mocked(invoke).mock.calls;
  await sendAudio(0, "trigger-a", 1);
  await listeners.get("browser-reading")!({ payload: { active: false, session_id: "trigger-a" } });
  audio.dispatchEvent(new Event("ended"));
  expect(calls().filter(([name]) => name === "browser_reading_finished")).toEqual([]);
  vi.mocked(invoke).mockClear();
  await sendAudio(0, "trigger-b", 1);
  expect(calls()).toContainEqual([
    "browser_reading_progress",
    expect.objectContaining({ sessionId: "trigger-b", fragmentIndex: 0 })
  ]);
  audio.dispatchEvent(new Event("ended"));
  expect(calls()).toContainEqual([
    "browser_reading_finished",
    { sessionId: "trigger-b", status: "completed" }
  ]);
});

it("binds a streamed clip to the session it belongs to once audible", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      resume = vi.fn();
      suspend = vi.fn();
      close = vi.fn();
    }
  );
  vi.spyOn(PcmStreamScheduler.prototype, "handleChunk").mockImplementation(() => {});
  vi.spyOn(PcmStreamScheduler.prototype, "getPlaybackPosition").mockReturnValue({
    fragmentIndex: 0,
    positionMs: 100
  });
  await listeners.get("synthesis-state-change")!({ payload: true });
  vi.mocked(invoke).mockClear();
  playbackStore.handleStreamChunk({
    audio_base64: "",
    sample_rate: 24000,
    channels: 1,
    bits_per_sample: 16,
    fragment_index: 0,
    fragment_total: 1,
    is_final: false,
    text: "streamed",
    session_id: "trigger-s"
  });
  expect(invoke).toHaveBeenCalledWith(
    "browser_reading_progress",
    expect.objectContaining({ sessionId: "trigger-s", fragmentIndex: 0 })
  );
  playbackStore.handleStop();
});

it("pauses and resumes idempotently on the element path", async () => {
  await sendAudio();
  playbackStore.pausePlayback();
  expect(playbackStore.isPaused).toBe(true);
  playbackStore.pausePlayback();
  expect(playbackStore.isPaused).toBe(true);
  expect(pauseSpy).toHaveBeenCalledTimes(1);
  playbackStore.resumePlayback();
  expect(playbackStore.isPaused).toBe(false);
  playbackStore.resumePlayback();
  expect(playbackStore.isPaused).toBe(false);
  expect(playSpy).toHaveBeenCalledTimes(2);
});

it("leaves an idle reading alone on pause, toggle-pause, and resume", () => {
  playbackStore.handleTogglePause();
  playbackStore.pausePlayback();
  playbackStore.resumePlayback();
  expect(playbackStore.isPaused).toBe(false);
  expect(pauseSpy).not.toHaveBeenCalled();
  expect(playSpy).not.toHaveBeenCalled();
});

it("routes pause, resume and seek from the control-server events", async () => {
  vi.spyOn(audio, "duration", "get").mockReturnValue(10);
  await sendAudio();
  await listeners.get("playback-pause")!({ payload: { delta_ms: 0 } });
  expect(playbackStore.isPaused).toBe(true);
  await listeners.get("playback-pause")!({ payload: { delta_ms: 0 } });
  expect(playbackStore.isPaused).toBe(true);
  await listeners.get("playback-resume")!({ payload: { delta_ms: 0 } });
  expect(playbackStore.isPaused).toBe(false);
  audio.currentTime = 4;
  await listeners.get("playback-seek")!({ payload: { delta_ms: 5000 } });
  expect(audio.currentTime).toBe(9);
  await listeners.get("playback-seek")!({ payload: { delta_ms: -5000 } });
  expect(audio.currentTime).toBe(4);
});

it("keeps a paused PCM caption active at its frozen position", async () => {
  vi.useFakeTimers();
  await startStreamingReading();
  vi.spyOn(PcmStreamScheduler.prototype, "handleChunk").mockImplementation(() => {});
  const position = vi
    .spyOn(PcmStreamScheduler.prototype, "getPlaybackPosition")
    .mockReturnValue({ fragmentIndex: 0, positionMs: 700 });
  playbackStore.handleStreamChunk({
    ...streamChunk(null),
    text: "streamed",
    captions: { text: "streamed", words: [] }
  });
  await vi.advanceTimersByTimeAsync(25);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ active: true, paused: false, position_ms: 700 })
  );
  position.mockReturnValue(null);
  playbackStore.pausePlayback();
  await vi.advanceTimersByTimeAsync(25);
  expect(emitTo).toHaveBeenLastCalledWith(
    "hud",
    "hud:caption",
    expect.objectContaining({ active: true, paused: true, position_ms: 700 })
  );
  playbackStore.handleStop();
});

/** An AudioParam the fake graph can connect into. */
interface FakeParam {
  value: number;
}

interface FakeAudioNode {
  kind: string;
  connections: Array<FakeAudioNode | FakeParam>;
  connect(target: FakeAudioNode | FakeParam): void;
  disconnect(): void;
  gain?: { value: number };
  type?: string;
  frequency?: { value: number };
  Q?: { value: number };
  curve?: Float32Array | null;
  oversample?: string;
  threshold?: { value: number };
  knee?: { value: number };
  ratio?: { value: number };
  attack?: { value: number };
  release?: { value: number };
}

/**
 * A full Web Audio graph stub: enough for the real live walkie chain, so the
 * scheduler's output gain can be traced into the effect input.
 */
function stubAudioGraph() {
  const nodes: FakeAudioNode[] = [];
  const oscillators: Array<{ start: () => void; stop: () => void }> = [];
  const node = (kind: string): FakeAudioNode => {
    const created: FakeAudioNode = {
      kind,
      connections: [],
      connect(target) {
        created.connections.push(target);
      },
      disconnect() {
        created.connections.length = 0;
      }
    };
    nodes.push(created);
    return created;
  };
  const param = () => ({ value: 0 });
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = node("destination");
      createGain = () => Object.assign(node("gain"), { gain: param() });
      createBiquadFilter = () =>
        Object.assign(node("biquad"), {
          type: "lowpass",
          frequency: param(),
          Q: param(),
          gain: param()
        });
      ["createWaveShaper"] = () =>
        Object.assign(node("waveshaper"), { curve: null, oversample: "none" });
      createDynamicsCompressor = () =>
        Object.assign(node("compressor"), {
          threshold: param(),
          knee: param(),
          ratio: param(),
          attack: param(),
          release: param()
        });
      createOscillator = () => {
        const start = vi.fn();
        const stop = vi.fn();
        oscillators.push({ start, stop });
        return Object.assign(node("oscillator"), {
          type: "sine",
          frequency: param(),
          start,
          stop
        });
      };
      createBufferSource = () =>
        Object.assign(node("source"), {
          buffer: null,
          loop: false,
          start: vi.fn(),
          stop: vi.fn(),
          onended: null
        });
      resume = vi.fn();
      suspend = vi.fn();
      close = vi.fn();
    }
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false }))
  );
  return { nodes, oscillators };
}

it("plays a walkie-talkie stream through the live chain, not the raw output", async () => {
  const { nodes, oscillators } = stubAudioGraph();
  playbackStore.syncPlaybackConfig(100, 1, 1, "walkie_talkie");
  await listeners.get("synthesis-state-change")!({ payload: true });
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(playbackStore.isPlaying).toBe(true);

  const biquads = nodes.filter((node) => node.kind === "biquad");
  const input = nodes.find((node) => node.kind === "gain" && node.connections[0] === biquads[0]);
  if (input === undefined) throw new Error("the live chain input gain is missing");
  expect(
    nodes.filter((node) => node.kind === "gain" && node.connections.includes(input))
  ).toHaveLength(1);
  expect(oscillators[0].start).toHaveBeenCalledOnce();

  playbackStore.handleStop();
  expect(oscillators[0].stop).toHaveBeenCalledOnce();
});

it("lets a completed stream's live chain ring out and self-dispose", async () => {
  vi.useFakeTimers();
  const { oscillators } = stubAudioGraph();
  playbackStore.syncPlaybackConfig(100, 1, 1, "walkie_talkie");
  await listeners.get("synthesis-state-change")!({ payload: true });
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(oscillators[0].start).toHaveBeenCalledOnce();

  await listeners.get("pagination:complete")!({ payload: null });
  expect(playbackStore.isPlaying).toBe(false);
  expect(oscillators[0].stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(oscillators[0].stop).toHaveBeenCalledOnce();
});

/** AudioContext stub for tests that use both playback engines in one reading. */
function stubCrossEngineContext() {
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      decodeAudioData = decode;
      createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      resume = vi.fn();
      suspend = vi.fn();
      close = vi.fn();
    }
  );
}

it("holds a streamed reading until the batch fragment path drains", async () => {
  stubCrossEngineContext();
  const receive = vi
    .spyOn(PcmStreamScheduler.prototype, "handleChunk")
    .mockImplementation(() => {});
  await listeners.get("synthesis-state-change")!({ payload: true });
  await sendAudio(0, undefined, 1);
  expect(playbackStore.isPlaying).toBe(true);

  playbackStore.handleStreamChunk({ ...streamChunk(null), is_final: true });
  expect(receive).not.toHaveBeenCalled();
  expect(playbackStore.isPlaying).toBe(true);

  vi.mocked(emit).mockClear();
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  expect(vi.mocked(emit)).toHaveBeenCalledWith("playback-started", { reading_id: null });
  playbackStore.handleStop();
});

it("holds a batch reading until the streamed scheduler drains", async () => {
  stubCrossEngineContext();
  vi.spyOn(PcmStreamScheduler.prototype, "handleChunk").mockImplementation(() => {});
  await listeners.get("synthesis-state-change")!({ payload: true });
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(playbackStore.isPlaying).toBe(true);

  await sendAudio(0, undefined, 1);
  expect(decode).not.toHaveBeenCalled();

  await listeners.get("pagination:complete")!({ payload: null });
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalled());
  expect(decode).toHaveBeenCalled();
  expect(playbackStore.isPlaying).toBe(true);
  playbackStore.handleStop();
});

it("drops a held stream when the reading is stopped", async () => {
  stubCrossEngineContext();
  const receive = vi
    .spyOn(PcmStreamScheduler.prototype, "handleChunk")
    .mockImplementation(() => {});
  await listeners.get("synthesis-state-change")!({ payload: true });
  await sendAudio(0, undefined, 1);
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(receive).not.toHaveBeenCalled();

  playbackStore.handleStop();
  audio.dispatchEvent(new Event("ended"));
  await Promise.resolve();
  expect(receive).not.toHaveBeenCalled();
});

/** A streamed chunk that carries its reading identity, as Rust now emits it. */
function readingChunk(
  readingId: number | undefined,
  fragmentIndex = 0,
  total = 1
): StreamChunkPayload {
  const chunk: StreamChunkPayload = {
    audio_base64: "",
    sample_rate: 24000,
    channels: 1,
    bits_per_sample: 16,
    fragment_index: fragmentIndex,
    fragment_total: total,
    is_final: fragmentIndex === total - 1,
    text: `Reading ${readingId ?? "none"} part ${fragmentIndex}`
  };
  if (readingId !== undefined) chunk.reading_id = readingId;
  return chunk;
}

/** Capture what each scheduler instance is fed, without decoding real PCM. */
function captureSchedulerChunks() {
  return vi.spyOn(PcmStreamScheduler.prototype, "handleChunk").mockImplementation(() => {});
}

it("holds a second streamed reading and replays it in order on its own scheduler", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  vi.mocked(emit).mockClear();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 2));
  playbackStore.handleStreamChunk(readingChunk(1, 1, 2));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(playbackStore.isPlaying).toBe(true);

  playbackStore.handleStreamChunk(readingChunk(2, 0, 2));
  playbackStore.handleStreamChunk(readingChunk(2, 1, 2));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(playbackStore.isPlaying).toBe(true);

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 1 part 1",
    "Reading 2 part 0",
    "Reading 2 part 1"
  ]);
  expect(vi.mocked(emit).mock.calls.filter(([name]) => name === "playback-started")).toHaveLength(
    2
  );
  playbackStore.handleStop();
});

it("does not complete the reading that still plays on another reading's completion", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  vi.mocked(emit).mockClear();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  expect(receive).toHaveBeenCalledTimes(1);

  await listeners.get("pagination:complete")!({ payload: { reading_id: 2 } });
  expect(playbackStore.isPlaying).toBe(true);
  expect(emit).not.toHaveBeenCalledWith("playback-finished", { reading_id: null });

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 2 part 0"
  ]);
  expect(playbackStore.isPlaying).toBe(false);
});

it("drops a held reading on stream or section failure, ignores its late chunks, and keeps the active stream playing", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  vi.mocked(emit).mockClear();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 2));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(3, 0, 1));

  await listeners.get("playback-stream-failed")!({
    payload: { session_id: null, reading_id: 2 }
  });
  const message = "Reading stopped: section 2 of 5 failed, so the rest was not read.";
  await listeners.get("reading-failed")!({ payload: { message, reading_id: 3 } });

  expect(playbackStore.error).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(message, { duration: 15000 });
  expect(playbackStore.isPlaying).toBe(true);
  expect(emit).not.toHaveBeenCalledWith("playback-finished", { reading_id: null });

  // Late chunks of failed held readings stay ignored while a newer reading can still enqueue.
  playbackStore.handleStreamChunk(readingChunk(2, 1, 2));
  playbackStore.handleStreamChunk(readingChunk(3, 1, 2));
  playbackStore.handleStreamChunk(readingChunk(4, 0, 1));

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 4 part 0"
  ]);
  playbackStore.handleStop();
});

it("drops a held streamed reading when the owner is stopped", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  expect(receive).toHaveBeenCalledTimes(1);

  playbackStore.handleStop();
  expect(playbackStore.isPlaying).toBe(false);
  await listeners.get("synthesis-state-change")!({ payload: true });
  playbackStore.handleStreamChunk(readingChunk(3, 0, 1));
  await listeners.get("pagination:complete")!({ payload: { reading_id: 3 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 3 part 0"
  ]);
  expect(playbackStore.isPlaying).toBe(false);
});

it("keeps the single anonymous stream when no identified scheduler is active", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();

  playbackStore.handleStreamChunk(streamChunk(null));
  playbackStore.handleStreamChunk({ ...streamChunk(null), fragment_index: 1, fragment_total: 2 });
  expect(receive).toHaveBeenCalledTimes(2);
  expect(playbackStore.isPlaying).toBe(true);
  await listeners.get("pagination:complete")!({ payload: null });
  expect(playbackStore.isPlaying).toBe(false);
});

it("names the audible reading on playback-started and playback-finished", async () => {
  await startStreamingReading();
  captureSchedulerChunks();
  vi.mocked(emit).mockClear();

  playbackStore.handleStreamChunk(readingChunk(7, 0, 1));
  expect(emit).toHaveBeenCalledWith("playback-started", { reading_id: 7 });

  await listeners.get("pagination:complete")!({ payload: { reading_id: 7 } });
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: 7 });
  expect(playbackStore.isPlaying).toBe(false);
});

it("drops late chunks of the stopped reading and heals the stop gate for a new identified reading", async () => {
  stubCrossEngineContext();
  const receive = captureSchedulerChunks();
  vi.mocked(emit).mockClear();

  // An idle stop remembers no reading, so the next identified chunk heals it.
  playbackStore.handleStop();
  playbackStore.handleStreamChunk(readingChunk(9, 0, 1));
  expect(receive).toHaveBeenCalledTimes(1);
  expect(playbackStore.isPlaying).toBe(true);

  playbackStore.handleStop();
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: 9 });

  // Late chunks of the stopped reading and id-less chunks stay dropped; another reading heals.
  playbackStore.handleStreamChunk(readingChunk(9, 1, 2));
  playbackStore.handleStreamChunk(streamChunk(null));
  expect(receive).toHaveBeenCalledTimes(1);

  playbackStore.handleStreamChunk(readingChunk(10, 0, 1));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenCalledWith("playback-started", { reading_id: 10 });
  playbackStore.handleStop();
});

it("bounds the held buffer to four runs by dropping the oldest reading", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  for (const readingId of [2, 3, 4, 5]) {
    playbackStore.handleStreamChunk(readingChunk(readingId, 0, 1));
  }
  playbackStore.handleStreamChunk(readingChunk(6, 0, 1));
  expect(warn).toHaveBeenCalledWith(
    "[PlaybackStore] dropping oldest held stream reading",
    2,
    "to keep the held-buffer cap"
  );

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 3 part 0"
  ]);
  playbackStore.handleStop();
});

it("bounds the held buffer by total bytes and drops the oldest reading", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const elevenMiB = 11 * 1024 * 1024;
  const big = (readingId: number) => ({
    ...readingChunk(readingId, 0, 1),
    audio_base64: "A".repeat(elevenMiB)
  });

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(big(2));
  playbackStore.handleStreamChunk(big(3));
  playbackStore.handleStreamChunk(big(4));
  expect(warn).toHaveBeenCalledWith(
    "[PlaybackStore] dropping oldest held stream reading",
    2,
    "to keep the held-buffer cap"
  );

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 3 part 0"
  ]);
  playbackStore.handleStop();
});

it("refuses a reading whose own held run breaks the per-reading cap", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  const oversized = {
    ...readingChunk(2, 0, 2),
    audio_base64: "A".repeat(32 * 1024 * 1024 + 1)
  };
  playbackStore.handleStreamChunk(oversized);
  expect(warn).toHaveBeenCalledWith(
    "[PlaybackStore] refusing held stream reading",
    2,
    "over the held-audio cap"
  );
  playbackStore.handleStreamChunk(readingChunk(2, 1, 2));

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual(["Reading 1 part 0"]);
  expect(playbackStore.isPlaying).toBe(false);
  playbackStore.handleStop();
});

it("stops only the failed audible reading, ignores its late chunks, and drains the waiting reading", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  playbackStore.handleStreamChunk(readingChunk(1, 0, 2));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  vi.mocked(emit).mockClear();

  await listeners.get("playback-stream-failed")!({
    payload: { session_id: null, reading_id: 1 }
  });
  expect(emit).toHaveBeenCalledWith("hud:stop", null);
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: 1 });
  expect(emit).toHaveBeenCalledWith("playback-started", { reading_id: 2 });
  expect(playbackStore.isPlaying).toBe(true);
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 2 part 0"
  ]);

  // Late chunk of failed reading 1 must not start a new scheduler.
  playbackStore.handleStreamChunk(readingChunk(1, 1, 2));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(emit).not.toHaveBeenCalledWith("playback-started", { reading_id: 1 });

  await listeners.get("pagination:complete")!({ payload: { reading_id: 2 } });
  expect(playbackStore.isPlaying).toBe(false);
  playbackStore.handleStreamChunk(readingChunk(1, 1, 2));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(playbackStore.isPlaying).toBe(false);
  playbackStore.handleStop();
});

it("attributes a held reading's failure without touching the audible reading", async () => {
  stubCrossEngineContext();
  const receive = captureSchedulerChunks();
  await listeners.get("synthesis-state-change")!({ payload: true });
  const message =
    "Reading stopped: section 2 of 5 failed, so the rest of the passage was not read.";

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  await sendAudio(0, undefined, 1);

  await listeners.get("reading-failed")!({ payload: { message, reading_id: 2 } });
  expect(playbackStore.error).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(message, { duration: 15000 });
  expect(playbackStore.isPlaying).toBe(true);

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual(["Reading 1 part 0"]);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  playbackStore.handleStop();
});

it("drops a held run with no terminal chunk or completion and keeps draining", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 2));
  playbackStore.handleStreamChunk(readingChunk(3, 0, 1));

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(warn).toHaveBeenCalledWith(
    "[PlaybackStore] dropping held stream reading",
    2,
    "with no terminal chunk or pagination:complete"
  );
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 3 part 0"
  ]);
  playbackStore.handleStop();
});

it("holds an id-less chunk apart from an identified scheduler and warns once", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  playbackStore.handleStreamChunk(readingChunk(1, 0, 2));
  playbackStore.handleStreamChunk({ ...streamChunk(null), is_final: true });
  playbackStore.handleStreamChunk({
    ...streamChunk(null),
    fragment_index: 1,
    fragment_total: 2,
    is_final: true
  });
  expect(receive).toHaveBeenCalledTimes(1);
  const anonymousWarnings = warn.mock.calls.filter(([line]) => String(line).includes("id-less"));
  expect(anonymousWarnings).toHaveLength(1);

  await listeners.get("pagination:complete")!({ payload: null });
  expect(playbackStore.isPlaying).toBe(true);

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "streamed",
    "streamed"
  ]);
  expect(playbackStore.isPlaying).toBe(true);
  await listeners.get("pagination:complete")!({ payload: null });
  expect(playbackStore.isPlaying).toBe(false);
  playbackStore.handleStop();
});

it("drains waiting readings from the lowest reading id, not arrival order", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(3, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 2 part 0"
  ]);
  await listeners.get("pagination:complete")!({ payload: { reading_id: 2 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual([
    "Reading 1 part 0",
    "Reading 2 part 0",
    "Reading 3 part 0"
  ]);
  expect(playbackStore.isPlaying).toBe(true);
  await listeners.get("pagination:complete")!({ payload: { reading_id: 3 } });
  expect(playbackStore.isPlaying).toBe(false);
});

it("keeps a waiting batch reading's fragments when a new synthesis starts", async () => {
  stubCrossEngineContext();
  captureSchedulerChunks();
  await listeners.get("synthesis-state-change")!({ payload: true });

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  await sendAudio(0, undefined, 1);
  expect(playbackStore.isPlaying).toBe(true);

  await listeners.get("synthesis-state-change")!({ payload: true });
  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  playbackStore.handleStop();
});

it("signals each batch reading at its audible boundary without ending the playback run", async () => {
  const send = async (readingId: number, index: number, total: number) =>
    playbackStore.handleFragmentReady({
      audio_base64: "YQ==",
      fragment_index: index,
      fragment_total: total,
      is_final: index === total - 1,
      text: `Reading ${readingId}, part ${index}`,
      reading_id: readingId
    });

  await send(41, 0, 2);
  await send(41, 1, 2);
  await send(42, 0, 1);
  await send(43, 0, 1);
  vi.mocked(emit).mockClear();

  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  expect(emit).not.toHaveBeenCalledWith("playback-reading-finished", expect.anything());

  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(3));
  expect(emit).toHaveBeenCalledWith("playback-reading-finished", { reading_id: 41 });
  expect(emit).not.toHaveBeenCalledWith("playback-finished", expect.anything());
  expect(emit).not.toHaveBeenCalledWith("playback-started", expect.anything());
  expect(emit).not.toHaveBeenCalledWith("hud:stop", expect.anything());
  expect(playbackStore.isPlaying).toBe(true);

  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(4));
  expect(emit).toHaveBeenCalledWith("playback-reading-finished", { reading_id: 42 });
  expect(emit).not.toHaveBeenCalledWith("playback-finished", expect.anything());

  audio.dispatchEvent(new Event("ended"));
  expect(emit).toHaveBeenCalledWith("playback-finished", { reading_id: 43 });
});

it("ignores a late chunk of a reading dropped by a scoped stop", async () => {
  await startStreamingReading();
  const receive = captureSchedulerChunks();

  playbackStore.handleStreamChunk(readingChunk(1, 0, 1));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  expect(receive).toHaveBeenCalledTimes(1);

  await listeners.get("playback-reading-dropped")!({ payload: { reading_id: 2 } });
  playbackStore.handleStreamChunk(readingChunk(2, 1, 2));
  playbackStore.handleStreamChunk(readingChunk(2, 0, 1));
  expect(receive).toHaveBeenCalledTimes(1);

  await listeners.get("pagination:complete")!({ payload: { reading_id: 1 } });
  expect(receive.mock.calls.map(([chunk]) => chunk.text)).toEqual(["Reading 1 part 0"]);
  expect(playbackStore.isPlaying).toBe(false);
  playbackStore.handleStop();
});

// Fragment prerender: the next fragment renders while the current one plays,
// so activation at the seam only swaps the blob URL.

class FakeAudioBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  private data: Float32Array[];
  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels;
    this.sampleRate = options.sampleRate;
    this.data = [];
    for (let c = 0; c < options.numberOfChannels; c++) {
      this.data.push(new Float32Array(options.length));
    }
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }
  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel].set(source.subarray(0, Math.min(source.length, this.length)));
  }
}

/**
 * Stub what jsdom lacks so a prerender runs its real pipeline: the AudioBuffer
 * constructor and blob URL registry. The URL assignment persists for the file;
 * other tests never hit the real createObjectURL (buildPlaybackUrl is spied).
 */
function stubAudioRendering() {
  vi.stubGlobal("AudioBuffer", FakeAudioBuffer);
  const revoked: string[] = [];
  let created = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:pre-${++created}`),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    })
  });
  decode.mockImplementation(
    async () => new FakeAudioBuffer({ length: 8000, numberOfChannels: 1, sampleRate: 8000 })
  );
  return { revoked };
}

it("plays the next fragment from its prerender without re-decoding at the seam", async () => {
  const { revoked } = stubAudioRendering();
  await sendAudio(0, undefined, 3);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  expect(decode).toHaveBeenCalledTimes(1);
  await sendAudio(1, undefined, 3);
  // Fragment 1 renders while fragment 0 plays.
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  // Activation reused the prerender: no third decode, and the playing URL is
  // the prerendered one, not the on-demand fallback.
  expect(decode).toHaveBeenCalledTimes(2);
  expect(audio.src).toBe("blob:pre-1");
  expect(playbackStore.currentFragmentIndex).toBe(1);
  // Fragment 2 prerenders while fragment 1 plays; a stop discards its URL.
  await sendAudio(2, undefined, 3);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3));
  playbackStore.handleStop();
  await vi.waitFor(() => expect(revoked).toContain("blob:pre-2"));
});

it("awaits an in-flight prerender instead of rendering the fragment again", async () => {
  stubAudioRendering();
  await sendAudio(0, undefined, 2);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  // Hold the prerender's decode open to simulate render work still running
  // when the current fragment ends.
  const gate = Promise.withResolvers<FakeAudioBuffer>();
  decode.mockImplementationOnce(() => gate.promise);
  await sendAudio(1, undefined, 2);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  audio.dispatchEvent(new Event("ended"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Fragment 1 neither played nor re-rendered while its prerender ran.
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledTimes(2);
  gate.resolve(new FakeAudioBuffer({ length: 8000, numberOfChannels: 1, sampleRate: 8000 }));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  expect(audio.src).toBe("blob:pre-1");
});

it("renders the next fragment while paused without resuming playback", async () => {
  stubAudioRendering();
  await sendAudio(0, undefined, 2);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  playbackStore.pausePlayback();
  expect(playbackStore.isPaused).toBe(true);
  playSpy.mockClear();
  await sendAudio(1, undefined, 2);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  // Prerender touches neither the element nor the pause state.
  expect(playbackStore.isPaused).toBe(true);
  expect(playSpy).not.toHaveBeenCalled();
  playbackStore.resumePlayback();
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(playbackStore.isPaused).toBe(false);
});

it("re-renders a prepared fragment on demand when the pitch changed while it waited", async () => {
  const { revoked } = stubAudioRendering();
  await sendAudio(0, undefined, 2);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  await sendAudio(1, undefined, 2);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  playbackStore.syncPlaybackConfig(100, 1, 0.9);
  audio.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));
  // The pitch-1 prerender was discarded, and activation re-rendered on demand.
  expect(revoked).toContain("blob:pre-1");
  expect(audio.src).toBe("blob:history-audio");
  expect(playbackStore.currentFragmentIndex).toBe(1);
});

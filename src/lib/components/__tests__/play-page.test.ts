// @vitest-environment jsdom

import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vite-plus/test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { waitForI18nReady } from "#lib/i18n";
import PlayPage from "../play-page.svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { historyStore } from "#lib/stores/history-store.svelte";
import { playbackStore } from "#lib/stores/playback-store.svelte";
import { testConfig } from "#lib/test-fixtures/app-config";
import type { AppConfig } from "#lib/types";

vi.mock("#lib/services/tauri.js", () => ({
  isTauri: true,
  invoke: async () => false
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {})
}));

vi.mock("#lib/stores/history-store.svelte", () => ({
  historyStore: {
    items: [],
    loadHistory: vi.fn(async () => {})
  }
}));

const { handleStop } = vi.hoisted(() => ({ handleStop: vi.fn() }));

vi.mock("#lib/stores/playback-store.svelte", () => ({
  playbackStore: {
    isPlaying: false,
    isPaused: false,
    isSynthesizing: false,
    caption: null,
    hasCachedAudio: false,
    historyReadingId: null,
    startReading: vi.fn(),
    handleStop,
    handleReplay: vi.fn(),
    handleTogglePause: vi.fn(),
    skipBackward: vi.fn(),
    skipForward: vi.fn(),
    syncPlaybackConfig: vi.fn()
  }
}));

beforeAll(async () => {
  await waitForI18nReady();
});

describe("play-page history gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires RecentHistory visibility and loadHistory through isHistoryEffective", async () => {
    const gated = testConfig();
    gated.general.experimental_enabled = false;
    gated.history.enabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "get_config" ? gated : undefined));

    const hiddenView = render(PlayPage);
    await waitFor(() => {
      expect(hiddenView.queryByRole("textbox")).not.toBeNull();
    });
    expect(hiddenView.queryByRole("region", { name: /Recent History/i })).toBeNull();
    expect(historyStore.loadHistory).not.toHaveBeenCalled();
    hiddenView.unmount();

    const enabled = testConfig();
    enabled.general.experimental_enabled = true;
    enabled.history.enabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_config" ? enabled : undefined
    );

    const visibleView = render(PlayPage);
    await waitFor(() => {
      expect(visibleView.queryByRole("region", { name: /Recent History/i })).not.toBeNull();
    });
    expect(historyStore.loadHistory).toHaveBeenCalled();
    visibleView.unmount();
  });
});

describe("play-page error dismissal", () => {
  it("dismisses a speak failure from its error box", async () => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_config") return testConfig();
      if (cmd === "speak_now") throw "The voice engine is not installed.";
      return undefined;
    });
    const view = render(PlayPage);
    try {
      await fireEvent.input(view.getByRole("textbox"), { target: { value: "hello" } });
      await fireEvent.click(view.getByRole("button", { name: "Play" }));

      const alert = await view.findByRole("alert");
      expect(alert.textContent).toContain("not installed");

      await fireEvent.click(view.getByRole("button", { name: "Dismiss error" }));
      await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    } finally {
      view.unmount();
      vi.restoreAllMocks();
    }
  });
});

describe("play-page stop", () => {
  it("aborts queued synthesis even when synthesis has not started", async () => {
    vi.clearAllMocks();
    playbackStore.isPlaying = true;
    playbackStore.isSynthesizing = false;
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "get_config" ? testConfig() : undefined
    );
    const view = render(PlayPage);
    try {
      await fireEvent.click(view.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("abort_synthesis"));
      expect(handleStop).toHaveBeenCalled();
    } finally {
      view.unmount();
      playbackStore.isPlaying = false;
      vi.restoreAllMocks();
    }
  });
});

describe("play-page config save pipeline", () => {
  // Keep in sync with SAVE_DEBOUNCE_MS in play-page.svelte.
  const SAVE_DEBOUNCE_MS = 500;
  const scrollIntoView = vi.fn();
  let configChanged: ((event: Event<unknown>) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    configChanged = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "config-changed") configChanged = handler;
      return () => {};
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  function deferredGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  function experimentalPlayConfig(): AppConfig {
    const config = testConfig();
    config.general.experimental_enabled = true;
    config.general.effects_enabled = true;
    config.tts.profiles = [
      {
        id: "default",
        name: "Default",
        description: null,
        engine: "kokoro",
        voice: "af_heart",
        voice_label: null,
        speed: 1,
        pitch: 1,
        effects: { enabled: false, active_effect: "none" },
        post_process: { enabled: false, active_template_id: null },
        engine_options: {}
      }
    ];
    return config;
  }

  interface SaveBackendOptions {
    getConfig: () => AppConfig;
    failSaves?: () => boolean;
    holdFirstSave?: boolean;
  }

  interface SaveBackend {
    saved: AppConfig[];
    cmdLog: string[];
    inFlight: () => number;
    maxConcurrent: () => number;
    release: () => void;
  }

  function mockSaveBackend(options: SaveBackendOptions): SaveBackend {
    const saved: AppConfig[] = [];
    const cmdLog: string[] = [];
    let active = 0;
    let maxConcurrent = 0;
    let hold: { promise: Promise<void>; resolve: () => void } | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
      cmdLog.push(String(cmd));
      if (cmd === "get_config") return options.getConfig();
      if (cmd === "set_config") {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        try {
          if (options.holdFirstSave && saved.length === 0) {
            hold = deferredGate();
            await hold.promise;
          }
          if (options.failSaves?.()) throw new Error("disk full");
        } finally {
          active--;
        }
        // SAFETY: this test backend only receives Play's typed set_config payload.
        saved.push(JSON.parse(JSON.stringify((payload as { newConfig: AppConfig }).newConfig)));
      }
      return undefined;
    });
    return {
      saved,
      cmdLog,
      inFlight: () => active,
      maxConcurrent: () => maxConcurrent,
      release: () => hold?.resolve()
    };
  }

  async function mountPlay() {
    vi.useFakeTimers();
    const view = render(PlayPage);
    for (let i = 0; i < 20 && view.container.querySelector("#qs-effects") === null; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    return view;
  }

  function effectsSwitch(view: { container: HTMLElement }): Element {
    const toggle = view.container.querySelector("#qs-effects");
    if (!toggle) throw new Error("Missing quick effects switch");
    return toggle;
  }

  async function fireConfigChanged() {
    if (!configChanged) throw new Error("config-changed listener not registered");
    const event = { event: "config-changed", id: 1, payload: null } satisfies Event<unknown>;
    configChanged(event);
    await tick();
  }

  it("persists edits on Play even when the debounced auto-save has not fired", async () => {
    const config = experimentalPlayConfig();
    const backend = mockSaveBackend({ getConfig: () => config });
    const view = await mountPlay();

    await fireEvent.click(effectsSwitch(view));
    await fireEvent.input(view.getByRole("textbox"), { target: { value: "hello" } });
    await fireEvent.click(view.getByRole("button", { name: "Play" }));
    await vi.advanceTimersByTimeAsync(1);

    expect(backend.saved).toHaveLength(1);
    expect(backend.saved[0].tts.profiles[0].effects.enabled).toBe(true);
    expect(backend.cmdLog.indexOf("set_config")).toBeLessThan(backend.cmdLog.indexOf("speak_now"));
    expect(invoke).toHaveBeenCalledWith("speak_now", { text: "hello" });
    expect(view.queryByText(/Failed to save settings/)).toBeNull();
    view.unmount();
  });

  it("serializes a debounced save behind an in-flight one and persists edits made meanwhile", async () => {
    const config = experimentalPlayConfig();
    const backend = mockSaveBackend({ getConfig: () => config, holdFirstSave: true });
    const view = await mountPlay();

    await fireEvent.click(effectsSwitch(view));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(backend.inFlight()).toBe(1);
    expect(backend.saved).toHaveLength(0);

    await fireEvent.click(effectsSwitch(view));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(backend.inFlight()).toBe(1);
    expect(backend.saved).toHaveLength(0);

    backend.release();
    await vi.advanceTimersByTimeAsync(1);

    expect(backend.saved).toHaveLength(2);
    expect(backend.maxConcurrent()).toBe(1);
    expect(backend.saved[0].tts.profiles[0].effects.enabled).toBe(true);
    expect(backend.saved[1].tts.profiles[0].effects.enabled).toBe(false);
    view.unmount();
  });

  it("flushes a later edit behind an in-flight auto-save before Play synthesizes", async () => {
    const config = experimentalPlayConfig();
    const backend = mockSaveBackend({ getConfig: () => config, holdFirstSave: true });
    const view = await mountPlay();

    await fireEvent.click(effectsSwitch(view));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await fireEvent.click(effectsSwitch(view));
    await fireEvent.input(view.getByRole("textbox"), { target: { value: "hello" } });
    await fireEvent.click(view.getByRole("button", { name: "Play" }));
    expect(backend.saved).toHaveLength(0);

    backend.release();
    await vi.advanceTimersByTimeAsync(1);

    expect(backend.saved).toHaveLength(2);
    expect(backend.maxConcurrent()).toBe(1);
    expect(backend.saved[1].tts.profiles[0].effects.enabled).toBe(false);
    expect(backend.cmdLog.indexOf("set_config")).toBeLessThan(backend.cmdLog.indexOf("speak_now"));
    expect(invoke).toHaveBeenCalledWith("speak_now", { text: "hello" });
    expect(view.queryByText(/Failed to save settings/)).toBeNull();
    view.unmount();
  });

  it("surfaces a failed save, blocks synthesis, and recovers on the next Play", async () => {
    const config = experimentalPlayConfig();
    const failing = { current: true };
    const backend = mockSaveBackend({ getConfig: () => config, failSaves: () => failing.current });
    const view = await mountPlay();

    await fireEvent.click(effectsSwitch(view));
    await fireEvent.input(view.getByRole("textbox"), { target: { value: "hello" } });
    await fireEvent.click(view.getByRole("button", { name: "Play" }));
    await vi.advanceTimersByTimeAsync(1);

    expect(view.queryByText(/Failed to save settings/)).not.toBeNull();
    expect(view.getByText(/disk full/)).not.toBeNull();
    expect(backend.cmdLog).not.toContain("speak_now");
    expect(backend.cmdLog).toContain("set_config");

    failing.current = false;
    await fireEvent.click(view.getByRole("button", { name: "Play" }));
    await vi.advanceTimersByTimeAsync(1);

    expect(backend.cmdLog).toContain("speak_now");
    expect(view.queryByText(/Failed to save settings/)).toBeNull();
    view.unmount();
  });

  it("does not clobber unsaved edits when a config-changed broadcast arrives", async () => {
    const serverState = experimentalPlayConfig();
    const backend = mockSaveBackend({ getConfig: () => structuredClone(serverState) });
    const view = await mountPlay();

    await fireEvent.click(effectsSwitch(view));
    serverState.playback.volume = 7;
    await fireConfigChanged();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(backend.saved).toHaveLength(1);
    expect(backend.saved[0].tts.profiles[0].effects.enabled).toBe(true);
    expect(backend.saved[0].playback.volume).toBe(100);
    expect(effectsSwitch(view).getAttribute("aria-checked")).toBe("true");

    serverState.playback.volume = 55;
    await fireConfigChanged();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(effectsSwitch(view).getAttribute("aria-checked")).toBe("false");
    expect(backend.saved).toHaveLength(1);
    view.unmount();
  });
});

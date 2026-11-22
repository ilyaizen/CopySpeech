// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { waitForI18nReady } from "#lib/i18n";
import { hudStore } from "#lib/stores/hud-store.svelte";
import { playbackStore } from "#lib/stores/playback-store.svelte";
import GlobalPlayer from "../global-player.svelte";
import HudPlaybackContent from "../hud/hud-playback-content.svelte";
import PlaybackControls from "../playback-controls.svelte";

vi.mock("#lib/services/tauri.js", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {})
}));

beforeAll(async () => {
  await waitForI18nReady();
});

afterEach(() => {
  cleanup();
  hudStore.handleStop();
  vi.restoreAllMocks();
});

describe("PlaybackControls", () => {
  it("renders the transport row and wires every button", async () => {
    const handlers = {
      onPlay: vi.fn(),
      onTogglePause: vi.fn(),
      onStop: vi.fn(),
      onSkipBack: vi.fn(),
      onSkipForward: vi.fn()
    };
    const view = render(PlaybackControls, {
      isPlaying: false,
      isPaused: false,
      isSynthesizing: false,
      playMode: "play",
      ...handlers
    });
    // SAFETY: every getByRole("button") match in this component is a <Button>,
    // which renders a real <button> element.
    const buttonsOf = () => view.getAllByRole("button") as HTMLButtonElement[];
    expect(buttonsOf()).toHaveLength(4);

    // Idle: skip and stop disabled, the primary button offers Play.
    let buttons = buttonsOf();
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[2].disabled).toBe(true);
    expect(buttons[3].disabled).toBe(true);
    await fireEvent.click(view.getByRole("button", { name: "Play" }));
    expect(handlers.onPlay).toHaveBeenCalledTimes(1);

    // Playing: skips enabled, the primary button becomes Pause, stop enabled.
    await view.rerender({ isPlaying: true });
    buttons = buttonsOf();
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(false);
    expect(buttons[3].disabled).toBe(false);
    await fireEvent.click(view.getByRole("button", { name: "Back 5 seconds" }));
    expect(handlers.onSkipBack).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole("button", { name: "Forward 5 seconds" }));
    expect(handlers.onSkipForward).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole("button", { name: "Pause" }));
    expect(handlers.onTogglePause).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole("button", { name: "Stop" }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);

    // Paused: the primary button offers Resume.
    await view.rerender({ isPlaying: false, isPaused: true });
    buttons = buttonsOf();
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
    await fireEvent.click(view.getByRole("button", { name: "Resume" }));
    expect(handlers.onTogglePause).toHaveBeenCalledTimes(2);

    // Replay mode keeps its tooltip on the primary button.
    await view.rerender({ isPaused: false, playMode: "replay" });
    await fireEvent.click(view.getByRole("button", { name: "Replay last audio" }));
    expect(handlers.onPlay).toHaveBeenCalledTimes(2);

    // Synthesizing without audio: the primary button is a disabled spinner.
    await view.rerender({ playMode: "disabled", isSynthesizing: true });
    buttons = buttonsOf();
    expect(view.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(buttons[1].disabled).toBe(true);
    await fireEvent.click(buttons[3]);
    expect(handlers.onStop).toHaveBeenCalledTimes(2);
  });
});

describe("GlobalPlayer", () => {
  it("reports real webview playback, pause and stop to the tray", async () => {
    vi.spyOn(playbackStore, "setupListeners").mockResolvedValue();
    vi.spyOn(playbackStore, "teardownListeners").mockImplementation(() => {});
    playbackStore.isPlaying = false;
    playbackStore.isPaused = false;
    render(GlobalPlayer);
    await tick();
    expect(invoke).toHaveBeenLastCalledWith("set_tray_playback_state", {
      playing: false,
      paused: false
    });
    playbackStore.isPlaying = true;
    await tick();
    expect(invoke).toHaveBeenLastCalledWith("set_tray_playback_state", {
      playing: true,
      paused: false
    });
    playbackStore.isPaused = true;
    await tick();
    expect(invoke).toHaveBeenLastCalledWith("set_tray_playback_state", {
      playing: true,
      paused: true
    });
    playbackStore.isPlaying = false;
    playbackStore.isPaused = false;
    await tick();
    expect(invoke).toHaveBeenLastCalledWith("set_tray_playback_state", {
      playing: false,
      paused: false
    });
  });
});

describe("HudPlaybackContent", () => {
  it("highlights a word, advances the phrase, and retains text without highlighting during buffering", async () => {
    const caption = {
      text: "One two. Three four.",
      captions: {
        text: "One two. Three four.",
        words: [
          { text_start: 0, text_end: 3, start_ms: 0, end_ms: 100 },
          { text_start: 4, text_end: 7, start_ms: 200, end_ms: 300 },
          { text_start: 9, text_end: 14, start_ms: 600, end_ms: 700 },
          { text_start: 15, text_end: 19, start_ms: 900, end_ms: 1000 }
        ]
      },
      position_ms: 0,
      duration_ms: 1000,
      paused: false,
      active: true
    };
    hudStore.handleCaption(caption);
    const view = render(HudPlaybackContent, { spokenText: caption.text, barValues: [] });
    expect(view.container.querySelector(".current")?.textContent?.trim()).toBe("One");
    expect(view.container.querySelector(".caption")?.textContent?.trim()).toBe("One two.");
    hudStore.handleCaption({ ...caption, position_ms: 950, paused: true });
    await tick();
    expect(view.container.querySelector(".current")?.textContent?.trim()).toBe("four.");
    expect(view.container.querySelector(".caption")?.textContent?.trim()).toBe("Three four.");
    hudStore.handleCaption({ ...caption, position_ms: 950, active: false });
    await tick();
    expect(view.container.querySelector(".current")).toBeNull();
    expect(view.container.querySelector(".caption")?.textContent?.trim()).toBe("Three four.");
  });
});

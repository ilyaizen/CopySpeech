// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AudioAnalyser } from "../analyser";

const frames: FrameRequestCallback[] = [];
const getByteFrequencyData = vi.fn((data: Uint8Array) => data.fill(200));
const emitTo = vi.fn(async () => {});

beforeEach(() => {
  frames.length = 0;
  getByteFrequencyData.mockClear();
  emitTo.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "AudioContext",
    class {
      destination = {};
      createMediaElementSource() {
        return { connect: vi.fn() };
      }
      createAnalyser() {
        return { connect: vi.fn(), frequencyBinCount: 128, getByteFrequencyData };
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runFrames(count: number) {
  for (let i = 1; i <= count; i++) frames.shift()?.(i * 20);
}

it("sends amplitude frames to the HUD only while the HUD gate is on", () => {
  const hud = { enabled: false };
  const analyser = new AudioAnalyser();
  analyser.setup(document.createElement("audio"), new AudioContext(), {
    emitTo,
    hudEnabled: () => hud.enabled
  });
  analyser.start();

  // HUD off: the loop keeps running but reads no data and crosses no IPC.
  runFrames(5);
  expect(emitTo).not.toHaveBeenCalled();
  expect(getByteFrequencyData).not.toHaveBeenCalled();
  expect(analyser.isRunning()).toBe(true);

  // Turning the HUD on mid-reading resumes the bars without a restart.
  hud.enabled = true;
  runFrames(1);
  expect(emitTo).toHaveBeenCalledWith("hud", "hud:amplitude", { bars: expect.any(Array) });

  hud.enabled = false;
  emitTo.mockClear();
  runFrames(5);
  expect(emitTo).not.toHaveBeenCalled();
});

it("keeps the HUD gate closed when the caller passes none", () => {
  const analyser = new AudioAnalyser();
  analyser.setup(document.createElement("audio"), new AudioContext(), { emitTo });
  analyser.start();
  runFrames(5);
  expect(emitTo).not.toHaveBeenCalled();
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { groundParallax } from "../ground-parallax";
import { syncLenisToLayout } from "../lenis-layout-sync";

// Frames run only when the test calls flush(). Mutations resolve on the next macrotask.
let frames: Map<number, FrameRequestCallback>;
let nextId: number;

function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setupLenis() {
  const wrapper = document.createElement("main");
  const content = document.createElement("div");
  wrapper.append(content);
  let scrollHeight = 1000;
  let clientHeight = 400;
  Object.defineProperty(wrapper, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(wrapper, "clientHeight", { get: () => clientHeight });

  // Mirrors Lenis: `limit` is a cached value that only `dimensions.resize()` refreshes.
  const lenis = {
    limit: scrollHeight - clientHeight,
    dimensions: {
      resize: vi.fn(() => {
        lenis.limit = wrapper.scrollHeight - wrapper.clientHeight;
      })
    }
  };

  return {
    wrapper,
    content,
    lenis,
    setScrollHeight: (value: number) => (scrollHeight = value)
  };
}

describe("syncLenisToLayout", () => {
  beforeEach(() => {
    frames = new Map();
    nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    // jsdom has no ResizeObserver. The wrapper's own resize is not under test here.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips redundant resizes when matched and refreshes stale limits after growth until settled", async () => {
    const { wrapper, content, lenis, setScrollHeight } = setupLenis();
    const cleanup = syncLenisToLayout(lenis, wrapper, content);

    // Matching limit does not re-measure.
    flush();
    flush();
    flush();
    expect(lenis.dimensions.resize).not.toHaveBeenCalled();

    setScrollHeight(1400);
    content.append(document.createElement("section"));
    await settle();
    flush();

    expect(lenis.dimensions.resize).toHaveBeenCalledTimes(1);
    expect(lenis.limit).toBe(1000);

    // Two quiet frames after the change end the loop.
    flush();
    flush();
    expect(frames.size).toBe(0);
    cleanup();
  });

  it("pumps while finite animations run and ignores infinite ones", () => {
    const infinite = setupLenis();
    Object.defineProperty(infinite.content, "getAnimations", {
      value: () => [{ effect: { getComputedTiming: () => ({ endTime: Infinity }) } }]
    });
    const stopInfinite = syncLenisToLayout(infinite.lenis, infinite.wrapper, infinite.content);
    flush();
    flush();
    flush();
    expect(frames.size).toBe(0);
    stopInfinite();

    const finite = setupLenis();
    let running = true;
    Object.defineProperty(finite.content, "getAnimations", {
      value: () => (running ? [{ effect: { getComputedTiming: () => ({ endTime: 300 }) } }] : [])
    });
    const stopFinite = syncLenisToLayout(finite.lenis, finite.wrapper, finite.content);
    for (let i = 0; i < 5; i++) flush();
    expect(frames.size).toBe(1);

    running = false;
    flush();
    flush();
    expect(frames.size).toBe(0);
    stopFinite();
  });

  it("cancels the pending frame and stops observing on cleanup", async () => {
    const { wrapper, content, lenis } = setupLenis();
    const cleanup = syncLenisToLayout(lenis, wrapper, content);
    expect(frames.size).toBe(1);

    cleanup();
    expect(frames.size).toBe(0);

    content.append(document.createElement("div"));
    await settle();
    expect(frames.size).toBe(0);
  });
});

describe("ground parallax", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks the full scroll range, bounds drift and cleans up", () => {
    const scroller = document.createElement("main");
    const ground = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 4400 });
    const motion = new EventTarget();
    Object.defineProperty(motion, "matches", { value: false });
    vi.stubGlobal("matchMedia", () => motion);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const cleanup = groundParallax(scroller, ground);
    scroller.scrollTop = 1000;
    scroller.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-14.5px");
    scroller.scrollTop = 2000;
    scroller.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-29.0px");
    scroller.scrollTop = 10000;
    scroller.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-58.0px");
    cleanup();
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("");
  });

  it("stays still under reduced motion, responds to changes, and cancels pending frames", () => {
    const scroller = document.createElement("main");
    const ground = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 800 });
    const motion = new EventTarget();
    let reduced = true;
    Object.defineProperty(motion, "matches", { get: () => reduced });
    vi.stubGlobal("matchMedia", () => motion);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const stopInitialReduced = groundParallax(scroller, ground);
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("");
    stopInitialReduced();

    reduced = false;
    const cleanup = groundParallax(scroller, ground);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-12.0px");
    reduced = true;
    motion.dispatchEvent(new Event("change"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("");
    scroller.dispatchEvent(new Event("scroll"));
    cleanup();
    expect(cancel).toHaveBeenCalledWith(1);
  });

  it("detaches the previous listener when the scroller changes", () => {
    const ground = document.createElement("div");
    const first = document.createElement("main");
    const second = document.createElement("main");
    Object.defineProperty(first, "clientHeight", { value: 400 });
    Object.defineProperty(second, "clientHeight", { value: 400 });
    Object.defineProperty(first, "scrollHeight", { value: 800 });
    Object.defineProperty(second, "scrollHeight", { value: 800 });
    const motion = new EventTarget();
    Object.defineProperty(motion, "matches", { value: false });
    vi.stubGlobal("matchMedia", () => motion);
    let frame: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const cleanupFirst = groundParallax(first, ground);
    first.scrollTop = 100;
    first.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-12.0px");

    cleanupFirst();
    const cleanupSecond = groundParallax(second, ground);
    requestFrame.mockClear();
    first.dispatchEvent(new Event("scroll"));
    expect(requestFrame).not.toHaveBeenCalled();
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("0.0px");
    second.scrollTop = 200;
    second.dispatchEvent(new Event("scroll"));
    frame?.(0);
    expect(ground.style.getPropertyValue("--bg-shift")).toBe("-24.0px");
    cleanupSecond();
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CaptionGlider, captionGlide } from "../caption-glide";

type Rect = { left: number; top: number; width: number; height: number };

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function setRects(el: HTMLElement, rects: Rect[]) {
  vi.spyOn(el, "getClientRects").mockImplementation(() => {
    const list: Record<number, Rect> = {};
    rects.forEach((r, index) => {
      list[index] = r;
    });
    // SAFETY: hand-builds the DOMRectList shape; no layout engine exists to make one.
    return {
      length: rects.length,
      item: (index: number) => rects[index] ?? null,
      ...list
    } as DOMRectList;
  });
}

function fixture() {
  const host = document.createElement("div");
  const a = document.createElement("span");
  const b = document.createElement("span");
  a.setAttribute("data-word-offset", "0");
  b.setAttribute("data-word-offset", "5");
  host.append(a, b);
  document.body.appendChild(host);
  // SAFETY: a plain rect object stands in for the layout engine.
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 100
  } as DOMRect);
  const mark = () => {
    const found = host.querySelector<HTMLElement>(".caption-glide-mark");
    if (found === null) throw new Error("the pill is not painted");
    return found;
  };
  return { host, a, b, mark };
}

function manualRaf() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const queue: { id: number; run: () => void }[] = [];
  const cancelled = new Set<number>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    queue.push({ id, run: () => cb(now) });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled.add(id);
  });
  return (delayMs: number) => {
    now += delayMs;
    const entry = queue.shift();
    if (entry !== undefined && !cancelled.has(entry.id)) entry.run();
  };
}

describe("caption glide", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("the first word paints the pill and settles instantly", () => {
    const { host, a, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    expect(mark().style.left).toBe("36px");
    expect(mark().style.top).toBe("18px");
    expect(mark().style.width).toBe("38px");
    expect(mark().style.height).toBe("16px");
  });

  it("a second word glides, then settles with the pill over it", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 20, 20, 12)]);
    const pump = manualRaf();
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.paint(b);
    expect(mark().style.transform).not.toBe("");
    expect(mark().style.width).toBe("38px");
    for (let i = 0; i < 10; i += 1) pump(30);
    expect(mark().style.left).toBe("76px");
    expect(mark().style.width).toBe("28px");
    expect(mark().style.transform).toBe("");
  });

  it("jumps between words when animation is off or reduced motion is enabled", () => {
    const off = fixture();
    setRects(off.a, [rect(40, 20, 30, 12)]);
    setRects(off.b, [rect(80, 20, 20, 12)]);
    const staticGlide = new CaptionGlider(off.host, false);
    staticGlide.paint(off.a);
    staticGlide.paint(off.b);
    expect(off.mark().style.left).toBe("76px");
    expect(off.mark().style.transform).toBe("");

    const reduced = fixture();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    setRects(reduced.a, [rect(40, 20, 30, 12)]);
    setRects(reduced.b, [rect(80, 20, 20, 12)]);
    const reducedGlide = new CaptionGlider(reduced.host, true);
    reducedGlide.paint(reduced.a);
    reducedGlide.paint(reduced.b);
    expect(reduced.mark().style.left).toBe("76px");
    expect(reduced.mark().style.transform).toBe("");
  });

  it("unmeasurable word settles without marks", () => {
    const { host, b } = fixture();
    const glide = new CaptionGlider(host, true);
    glide.paint(b);
    expect(host.querySelectorAll(".caption-glide-mark")).toHaveLength(0);
  });

  it("clear drops the paint and the mark", () => {
    const { host, a } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.clear();
    expect(host.querySelectorAll(".caption-glide-mark")).toHaveLength(0);
  });

  it("a gap between words holds the pill (no teardown)", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 20, 20, 12)]);
    const pump = manualRaf();
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.paint(null);
    expect(mark().style.left).toBe("36px");
    glide.paint(b);
    expect(mark().style.transform).not.toBe("");
    glide.paint(null);
    for (let i = 0; i < 10; i += 1) pump(30);
    expect(mark().style.transform).toBe("");
    expect(mark().style.left).toBe("76px");
  });

  it("a new resetKey clears the held paint and destroy removes the mark", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 20, 20, 12)]);
    const pump = manualRaf();
    const words = [
      { text: "one", offset: 0, start: 0, end: 100, phrase: 0 },
      { text: "two", offset: 5, start: 100, end: 200, phrase: 0 }
    ];
    const action = captionGlide(host, { words, activeIndex: 0, animated: true, resetKey: "r1" });
    action.update?.({ words, activeIndex: 1, animated: true, resetKey: "r1" });
    for (let i = 0; i < 10; i += 1) pump(30);
    action.update?.({ words, activeIndex: -1, animated: true, resetKey: "r1" });
    expect(mark().style.left).toBe("76px");

    // A new reading (resetKey) clears the held word first, so painting word 0 settles instead of gliding from word 1.
    action.update?.({ words, activeIndex: 0, animated: true, resetKey: "r2" });
    expect(mark().style.left).toBe("36px");
    expect(mark().style.transform).toBe("");

    action.destroy?.();
    expect(host.querySelector(".caption-glide-mark")).toBeNull();
  });

  it("painting the same word mid-glide does not restart the glide", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 20, 20, 12)]);
    const pump = manualRaf();
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.paint(b);
    pump(0);
    pump(60);
    const midFlight = mark().style.transform;
    expect(midFlight).not.toBe("translate(-40px,0px)");
    glide.paint(b);
    expect(mark().style.transform).toBe(midFlight);
    for (let i = 0; i < 10; i += 1) pump(30);
    expect(mark().style.transform).toBe("");
    expect(mark().style.left).toBe("76px");
  });

  it("a repeated word only re-places a moved pill", () => {
    const { host, b, mark } = fixture();
    setRects(b, [rect(80, 20, 20, 12)]);
    const glide = new CaptionGlider(host, true);
    glide.paint(b);
    vi.restoreAllMocks();
    setRects(b, [rect(200, 40, 20, 12)]);
    glide.paint(b);
    expect(mark().style.left).toBe("196px");
    expect(mark().style.top).toBe("38px");
  });

  it("anchors a late first frame and caps late frame steps instead of snapping", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 20, 20, 12)]);
    const pump = manualRaf();
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.paint(b);
    // First frame arrives late: anchors at start without jumping ahead.
    pump(130);
    expect(mark().style.transform).not.toBe("");
    // Each subsequent late frame advances by at most MARK_FRAME_CAP_MS (40 ms).
    pump(130);
    expect(mark().style.transform).not.toBe("");
    pump(130);
    expect(mark().style.transform).not.toBe("");
    pump(130);
    expect(mark().style.transform).toBe("");
    expect(mark().style.left).toBe("76px");
  });

  it("a word on a new line snaps to that line and animates its width there", () => {
    const { host, a, b, mark } = fixture();
    setRects(a, [rect(40, 20, 30, 12)]);
    setRects(b, [rect(80, 44, 20, 12)]);
    const pump = manualRaf();
    const glide = new CaptionGlider(host, true);
    glide.paint(a);
    glide.paint(b);
    expect(mark().style.left).toBe("76px");
    expect(mark().style.top).toBe("42px");
    expect(mark().style.transform).not.toBe("");
    for (let i = 0; i < 10; i += 1) pump(30);
    expect(mark().style.left).toBe("76px");
    expect(mark().style.top).toBe("42px");
    expect(mark().style.width).toBe("28px");
    expect(mark().style.transform).toBe("");
  });
});

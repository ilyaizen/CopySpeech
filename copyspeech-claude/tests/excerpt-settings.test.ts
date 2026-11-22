import { expect, mock, test } from "claude-code/testing";

// The captions pane, docked beside the transcript.
const PANE = {
  plugin: "copyspeech",
  surface: "desktop",
  component: "Pane",
  requestId: "captions",
  props: {
    title: "CopySpeech Reader",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 20 },
    view: {}
  }
} as const;

const OPTIONS = {
  autoRead: false,
  skipSections: true,
  excerpt: true,
  excerptMode: "both",
  excerptTop: 2,
  excerptBottom: 2,
  captions: true
};

// The desktop list omits the number rows, so the pane writes them without a listed row.
test(
  "excerpt off hides Part, Top and Bottom; on shows them",
  { options: { ...OPTIONS, excerpt: false } },
  async ($, on) => {
    const clock = mock.clock(on);
    on("config.list", () => ({ value: [] }));
    on("config.set", (_, e) => ({ value: e.value }));
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    expect(await pane.find({ key: "excerptMode" })).toBeUndefined();
    expect(await pane.find({ key: "excerptTop-up" })).toBeUndefined();
    expect(await pane.find({ key: "excerptBottom-up" })).toBeUndefined();
    await pane.press({ key: "excerpt" });
    await clock.advance(1);
    await pane.redraw();
    expect(await pane.find({ key: "excerptMode" })).toBeDefined();
    expect(await pane.find({ key: "excerptTop-up" })).toBeDefined();
    expect(await pane.find({ key: "excerptBottom-down" })).toBeDefined();
    await pane.unmount();
  }
);

test(
  "the Top and Bottom steppers write the count, clamped to 1 to 20",
  { options: { ...OPTIONS, excerptTop: 20, excerptBottom: 1 } },
  async ($, on) => {
    const clock = mock.clock(on);
    const writes: [string, unknown][] = [];
    on("config.list", () => ({ value: [] }));
    on("config.set", (_, e) => {
      writes.push([e.key, e.value]);
      return { value: e.value };
    });
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    // Top is at its maximum: up writes nothing.
    await pane.press({ key: "excerptTop-up" });
    await clock.advance(1);
    await pane.press({ key: "excerptTop-down" });
    await clock.advance(1);
    // Bottom is at its minimum: down writes nothing.
    await pane.press({ key: "excerptBottom-down" });
    await clock.advance(1);
    await pane.press({ key: "excerptBottom-up" });
    await clock.advance(1);
    expect(writes).toEqual([
      ["copyspeech@inline.excerptTop", 19],
      ["copyspeech@inline.excerptBottom", 2]
    ]);
    await pane.unmount();
  }
);

test("the Part button writes the next mode", { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on);
  const writes: [string, unknown][] = [];
  on("config.list", () => ({ value: [] }));
  on("config.set", (_, e) => {
    writes.push([e.key, e.value]);
    return { value: e.value };
  });
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "settings" });
  await clock.advance(1);
  await pane.press({ key: "excerptMode" });
  await clock.advance(1);
  expect(writes).toEqual([["copyspeech@inline.excerptMode", "top"]]);
  await pane.unmount();
});

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

// The boolean settings; the rest are choices or numbers.
const BOOLEAN_FIELDS = new Set(["autoRead", "skipSections", "excerpt", "captions"]);

const RUN = {
  command: "copyspeech-settings",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 }
} as const;

test(
  "the captions pane's settings write the plugin's own rows",
  { options: OPTIONS },
  async ($, on) => {
    const values = new Map<string, boolean | number | string>(Object.entries(OPTIONS));
    const writes: [string, unknown][] = [];
    on("config.list", () => ({
      value: [...values].map(([field, value]) => ({
        key: `copyspeech@inline.${field}`,
        label: field,
        kind: BOOLEAN_FIELDS.has(field) ? "boolean" : "choice",
        value,
        provider: { plugin: "copyspeech@inline", tier: "user" },
        isLocked: false
      }))
    }));
    on("config.set", (_, e) => {
      writes.push([e.key, e.value]);
      // SAFETY: this test writes only its OPTIONS values, which are booleans, numbers, or strings.
      values.set(e.key.slice(e.key.lastIndexOf(".") + 1), e.value as boolean | number | string);
      return { value: e.value };
    });

    const clock = mock.clock(on);
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    await pane.press({ key: "captions" });
    await clock.advance(1);
    await pane.press({ key: "excerptMode" });
    await clock.advance(1);
    expect(writes).toEqual([
      ["copyspeech@inline.captions", false],
      ["copyspeech@inline.excerptMode", "top"]
    ]);
    await pane.unmount();
  }
);

test("/copyspeech-settings opens the captions pane", async ($, on) => {
  const opened: string[] = [];
  on("http.fetch", () => ({ value: { status: 200, ok: true, headers: {}, text: "{}" } }));
  on("ui.open", (_, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  const result = await $.command.run(RUN);
  expect(opened).toEqual(["captions"]);
  expect(result.text).toBe("CopySpeech settings are in the Reader pane.");
});

test("/copyspeech-settings opens no pane while CopySpeech is down", async ($, on) => {
  const opened: string[] = [];
  on("http.fetch", () => ({ value: { status: 503, ok: false, headers: {}, text: "" } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.open", (_, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  const result = await $.command.run(RUN);
  expect(opened).toEqual([]);
  expect(result.text).toBe("CopySpeech is not running.");
});

test(
  "a setting the list does not return writes under its /config key",
  { options: OPTIONS },
  async ($, on) => {
    const clock = mock.clock(on);
    const keys: string[] = [];
    on("config.list", () => ({ value: [] }));
    on("config.set", (_, e) => {
      keys.push(e.key);
      return { value: e.value };
    });
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    await pane.press({ key: "captions" });
    await clock.advance(1);
    expect(keys).toEqual(["copyspeech@inline.captions"]);
    await pane.unmount();
  }
);

test(
  "a refused key falls back to the plugin's other /config name",
  { options: OPTIONS },
  async ($, on) => {
    const clock = mock.clock(on);
    const keys: string[] = [];
    on("config.list", () => ({ value: [] }));
    on("config.set", (_, e) => {
      keys.push(e.key);
      return e.key === "copyspeech.captions" ? { value: e.value } : { deny: "no such row" };
    });
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    await pane.press({ key: "captions" });
    await clock.advance(1);
    expect(keys).toEqual(["copyspeech@inline.captions", "copyspeech.captions"]);
    await pane.unmount();
  }
);

test(
  "a toggle shows the value the engine took, before any reload",
  { options: OPTIONS },
  async ($, on) => {
    const clock = mock.clock(on);
    on("config.list", () => ({ value: [] }));
    on("config.set", (_, e) => ({ value: e.value }));
    const pane = await $.ui.mount(PANE);
    await pane.press({ key: "settings" });
    await clock.advance(1);
    await pane.press({ key: "captions" });
    await clock.advance(1);
    await pane.redraw();
    expect((await pane.find({ key: "captions" }))?.props.label).toBe("Show captions: Off");
    await pane.unmount();
  }
);

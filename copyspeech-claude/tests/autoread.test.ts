import { expect, mock, test } from "claude-code/testing";

// The captions pane, docked beside the transcript.
const PANE = {
  plugin: "copyspeech",
  surface: "desktop",
  component: "Pane",
  requestId: "captions",
  props: {
    title: "CopySpeech companion",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 20 },
    view: {}
  }
} as const;

const RUN = {
  command: "copyspeech-autoread",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 }
} as const;

test("/copyspeech-autoread flips the plugin's own config row", async ($, on) => {
  let stored: boolean | string | number | readonly string[] = false;
  const keys: string[] = [];
  on("config.list", () => ({
    value: [
      {
        key: "theme",
        label: "Theme",
        kind: "choice",
        value: "dark",
        provider: { plugin: "engine", tier: "core" },
        isLocked: false
      },
      {
        key: "copyspeech@inline.autoRead",
        label: "Read new replies aloud",
        kind: "boolean",
        value: stored,
        provider: { plugin: "copyspeech@inline", tier: "user" },
        isLocked: false
      }
    ]
  }));
  on("config.set", (_, e) => {
    keys.push(e.key);
    stored = e.value;
    return { value: e.value };
  });

  const first = await $.command.run(RUN);
  expect(first.text).toBe("CopySpeech auto-read is on.");
  expect(stored).toBe(true);
  const second = await $.command.run(RUN);
  expect(second.text).toBe("CopySpeech auto-read is off.");
  expect(stored).toBe(false);
  expect(keys).toEqual(["copyspeech@inline.autoRead", "copyspeech@inline.autoRead"]);
});

test(
  "submitting a prompt with auto-read on opens the captions pane before the reply",
  { options: { autoRead: true, captions: true } },
  async ($, on) => {
    const opened: string[] = [];
    on("prompt.submit", (_, e) => ({ text: e.text }));
    on("ui.open", (_, e) => {
      opened.push(e.id);
      return { value: { isPlaced: true } };
    });
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
    expect(opened).toEqual(["captions"]);
  }
);

test(
  "submitting a prompt with auto-read off leaves the captions pane alone",
  { options: { autoRead: false, captions: true } },
  async ($, on) => {
    const opened: string[] = [];
    on("prompt.submit", (_, e) => ({ text: e.text }));
    on("ui.open", (_, e) => {
      opened.push(e.id);
      return { value: { isPlaced: true } };
    });
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
    expect(opened).toEqual([]);
  }
);

test(
  "an auto-read reply opens the captions pane and shows the reply there",
  { options: { autoRead: true, captions: true, skipSections: false, excerpt: false } },
  async ($, on) => {
    const clock = mock.clock(on);
    const opened: string[] = [];
    const speaks: string[] = [];
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("ui.open", (_, e) => {
      opened.push(e.id);
      return { value: { isPlaced: true } };
    });
    on("http.fetch", (_, e) => {
      if (e.url.endsWith("/speak")) speaks.push(JSON.stringify(e.init?.body ?? ""));
      return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
    });
    await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
    const reply = await $.ui.mount({
      plugin: "copyspeech",
      surface: "desktop",
      component: "AssistantMessage",
      requestId: "reply-1",
      props: { text: "Hello there.", isFirstOfReply: true }
    });
    await $.turn.complete({
      answer: "Hello there.",
      durationMs: 10,
      isAborted: false,
      turnId: "turn-1",
      reason: "answer"
    });
    await clock.advance(250);
    expect(opened).toEqual(["captions"]);
    expect(speaks.length).toBe(1);
    const pane = await $.ui.mount(PANE);
    await pane.redraw();
    expect(await pane.find({ type: "Text", text: "Nothing read yet." })).toBeUndefined();
    expect(await pane.find({ type: "Markdown", text: /Hello/ })).toBeDefined();
    await pane.unmount();
    await reply.unmount();
  }
);

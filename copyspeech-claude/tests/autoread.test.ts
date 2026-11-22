import { expect, mock, test } from "claude-code/testing";

// The band above the prompt: one row per plugin, drawn while a reading plays.
const BAND = {
  plugin: "copyspeech",
  surface: "desktop",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {}
  }
} as const;

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
    on("http.fetch", () => ({ value: { status: 200, ok: true, headers: {}, text: "{}" } }));
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
    on("prompt.submit", (_, e) => ({ text: e.text }));
    await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
    // A turn starts at the prompt; the plugin collects its replies from there.
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
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
    expect(opened).toContain("captions");
    expect(speaks.length).toBe(1);
    const pane = await $.ui.mount(PANE);
    await pane.redraw();
    expect(await pane.find({ type: "Text", text: "Nothing read yet." })).toBeUndefined();
    expect(await pane.find({ type: "Markdown", text: /Hello/ })).toBeDefined();
    await pane.unmount();
    await reply.unmount();
  }
);

test(
  "an auto-read reading puts the chip on the spoken word in the pane",
  { options: { autoRead: true, captions: true, skipSections: false, excerpt: false } },
  async ($, on) => {
    const clock = mock.clock(on);
    const status = {
      active: true,
      paused: false,
      position_ms: 100,
      fragment_index: 0,
      captions: {
        text: "Hello there.",
        words: [
          { text_start: 0, text_end: 5, start_ms: 0, end_ms: 300 },
          { text_start: 6, text_end: 11, start_ms: 300, end_ms: 600 }
        ]
      }
    };
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    on("http.fetch", (_, e) => ({
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: e.url.endsWith("/status") ? JSON.stringify(status) : "{}"
      }
    }));
    on("prompt.submit", (_, e) => ({ text: e.text }));
    await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
    // A turn starts at the prompt; the plugin collects its replies from there.
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
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
    const pane = await $.ui.mount(PANE);
    await pane.redraw();
    const word = await pane.find({ type: "Text", text: /^Hello$/ });
    expect(word?.props).toEqual({ backgroundColor: "text", color: "inverseText" });
    // The playbox: Pause in the pane's header row, and in the band above the prompt.
    expect(await pane.find({ key: "pane-pause" })).toBeDefined();
    const band = await $.ui.mount(BAND);
    await band.redraw();
    expect(await band.find({ key: "pause" })).toBeDefined();
    await band.unmount();
    await pane.unmount();
    await reply.unmount();
  }
);

test(
  "auto-read speaks and shows the playbox even while the captions pane is not yet placed",
  { options: { autoRead: true, captions: true, skipSections: false, excerpt: false } },
  async ($, on) => {
    const clock = mock.clock(on);
    const speaks: string[] = [];
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    // The pane waits undrawn: the open never answers.
    on("ui.open", () => new Promise(() => {}));
    on("http.fetch", (_, e) => {
      if (e.url.endsWith("/speak")) speaks.push(JSON.stringify(e.init?.body ?? ""));
      return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
    });
    on("prompt.submit", (_, e) => ({ text: e.text }));
    await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
    // A turn starts at the prompt; the plugin collects its replies from there.
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
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
    expect(speaks.length).toBe(1);
    const band = await $.ui.mount(BAND);
    await band.redraw();
    expect(await band.find({ key: "pause" })).toBeDefined();
    await band.unmount();
    await reply.unmount();
  }
);

test(
  "auto-read speaks only the turn's last text block, not the narration before it",
  { options: { autoRead: true, captions: false, skipSections: false, excerpt: false } },
  async ($, on) => {
    const clock = mock.clock(on);
    const speaks: string[] = [];
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("turn.complete", () => ({ text: "" }));
    on("prompt.submit", (_, e) => ({ text: e.text }));
    on("http.fetch", (_, e) => {
      if (e.url.endsWith("/speak")) speaks.push(JSON.stringify(e.init?.body ?? ""));
      return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
    });
    await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
    await $.prompt.submit({ text: "Say hello", wait: false, origin: { kind: "composer" } });
    const narration = await $.ui.mount({
      plugin: "copyspeech",
      surface: "desktop",
      component: "AssistantMessage",
      requestId: "reply-1",
      props: { text: "Let me read the file.", isFirstOfReply: true }
    });
    const answer = await $.ui.mount({
      plugin: "copyspeech",
      surface: "desktop",
      component: "AssistantMessage",
      requestId: "reply-2",
      props: { text: "Hello there.", isFirstOfReply: false }
    });
    await $.turn.complete({
      answer: "Hello there.",
      durationMs: 10,
      isAborted: false,
      turnId: "turn-1",
      reason: "answer"
    });
    await clock.advance(250);
    expect(speaks.length).toBe(1);
    expect(speaks[0]).toContain("Hello there");
    expect(speaks[0]).not.toContain("Let me read");
    await answer.unmount();
    await narration.unmount();
  }
);

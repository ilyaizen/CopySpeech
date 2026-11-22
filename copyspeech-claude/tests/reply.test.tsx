import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

const REPLY = { text: "Hello there.", isFirstOfReply: true } as const;
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

test("desktop reply's play button is the plain word Read, with no icon", async ($) => {
  const ui = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: REPLY
  });

  expect(await ui.find({ type: "Svg" })).toBeUndefined();
  expect(await ui.find({ key: "play-reply-1", text: "Read" })).toBeDefined();
  await ui.unmount();
});

test("terminal reply has no Svg and labels the button with a ▶", async ($) => {
  const ui = await $.ui.mount({
    plugin: "copyspeech",
    surface: "terminal",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: REPLY
  });

  expect(await ui.find({ type: "Svg" })).toBeUndefined();
  expect(await ui.find({ key: "play-reply-1", text: "▶ Read" })).toBeDefined();
  await ui.unmount();
});

test("a playing reply shows Pause and Stop in the band; Pause posts /pause, Stop posts a global /stop", async ($, on) => {
  const clock = mock.clock(on);
  const urls: string[] = [];
  const bodies: string[] = [];
  on("http.fetch", (_, e) => {
    urls.push(e.url);
    bodies.push(JSON.stringify(e.init?.body ?? ""));
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const ui = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: REPLY
  });
  const band = await $.ui.mount(BAND);
  expect(await band.find({ key: "pause" })).toBeUndefined();

  await ui.press({ key: "play-reply-1" });
  await clock.settle();
  await band.redraw();
  expect(await band.find({ key: "pause" })).toBeDefined();
  expect(await band.find({ key: "stop" })).toBeDefined();

  await band.press({ key: "pause" });
  await clock.settle();
  expect(urls.some((u) => u.endsWith("/pause"))).toBe(true);

  await band.press({ key: "stop" });
  await clock.settle();
  const stop = urls.lastIndexOf(urls.find((u) => u.endsWith("/stop")) ?? "");
  expect(stop).toBeGreaterThan(-1);
  // No request_id: CopySpeech's global stop, which also aborts queued synthesis.
  expect(bodies[stop]).toBe(JSON.stringify("{}"));
  await band.redraw();
  expect(await band.find({ key: "pause" })).toBeUndefined();
  await band.unmount();
  await ui.unmount();
});

test(
  "the play button on a reply says Read, with or without trims",
  { options: { skipSections: false, excerpt: false } },
  async ($) => {
    const ui = await $.ui.mount({
      plugin: "copyspeech",
      surface: "terminal",
      component: "AssistantMessage",
      requestId: "reply-1",
      props: REPLY
    });
    expect(await ui.find({ key: "play-reply-1", text: "▶ Read" })).toBeDefined();
    await ui.unmount();
  }
);

// /status speaks "Hello there." with "there" under the clock; the play button starts the poll.
// `status` is the value /status returns: a test moves the clock by changing its position_ms.
async function playHello($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on);
  const status = {
    active: true,
    paused: false,
    position_ms: 350,
    fragment_index: 0,
    captions: {
      text: "Hello there.",
      words: [
        { text_start: 0, text_end: 5, start_ms: 0, end_ms: 300 },
        { text_start: 6, text_end: 11, start_ms: 300, end_ms: 600 }
      ]
    }
  };
  on("http.fetch", (_, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: e.url.endsWith("/status") ? JSON.stringify(status) : "{}"
    }
  }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  const opened: string[] = [];
  on("ui.open", (_, e) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  // Starts the /status poll.
  await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
  const mount = (requestId: string) =>
    $.ui.mount({
      plugin: "copyspeech",
      surface: "desktop",
      component: "AssistantMessage",
      requestId,
      props: REPLY
    });
  const playing = await mount("reply-1");
  const other = await mount("reply-2");
  const band = await $.ui.mount(BAND);
  await playing.press({ key: "play-reply-1" });
  const pane = await $.ui.mount(PANE);
  await clock.advance(250);
  await playing.redraw();
  await other.redraw();
  await band.redraw();
  return { playing, other, band, pane, opened, status, clock };
}

test("a reading opens the captions pane and puts a chip on the spoken word there; replies keep the engine's drawing", async ($, on) => {
  // The test host has no `$.ui.scroll`, so the pane's scroll to the word is not checked here.
  const { playing, other, band, pane, opened } = await playHello($, on);
  expect(opened).toContain("captions");
  const word = await pane.find({ type: "Text", text: /^there$/ });
  expect(word?.props).toEqual({ backgroundColor: "text", color: "inverseText" });
  expect(await playing.find({ type: "Text", text: /^there$/ })).toBeUndefined();
  expect(await other.find({ type: "Text", text: /^there$/ })).toBeUndefined();
  expect(await playing.find({ key: "pause-reply-1" })).toBeUndefined();
  // The settings Buttons show only while nothing is read.
  expect(await pane.find({ key: "captions" })).toBeUndefined();
  expect(await band.find({ key: "stop" })).toBeDefined();
  await pane.unmount();
  await other.unmount();
  await band.unmount();
  await playing.unmount();
});

test("a reply's blocks without the spoken word draw as the engine's Markdown; the spoken block draws the chip", async ($, on) => {
  const clock = mock.clock(on);
  const status = {
    active: true,
    paused: false,
    position_ms: 350,
    fragment_index: 0,
    captions: {
      text: "Hello there.",
      words: [
        { text_start: 0, text_end: 5, start_ms: 0, end_ms: 300 },
        { text_start: 6, text_end: 11, start_ms: 300, end_ms: 600 }
      ]
    }
  };
  on("http.fetch", (_, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: e.url.endsWith("/status") ? JSON.stringify(status) : "{}"
    }
  }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text: "First paragraph here.\n\nHello there.", isFirstOfReply: true }
  });
  await reply.press({ key: "play-reply-1" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  await pane.redraw();
  expect(await pane.find({ type: "Markdown", text: "First paragraph here." })).toBeDefined();
  expect(await pane.find({ type: "Text", text: /^First/ })).toBeUndefined();
  // Position 350 ms is inside "there" (300-600 ms).
  const word = await pane.find({ type: "Text", text: /^there$/ });
  expect(word?.props).toEqual({ backgroundColor: "text", color: "inverseText" });
  await pane.unmount();
  await reply.unmount();
});

test("the pane's header row shows Read when idle, then Pause and Stop while a reading plays, and Settings stays", async ($, on) => {
  const clock = mock.clock(on);
  const urls: string[] = [];
  on("http.fetch", (_, e) => {
    urls.push(e.url);
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const ui = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: REPLY
  });
  const pane = await $.ui.mount(PANE);
  // The header comes first: the colored mark and the name, then the playbox and Settings.
  expect(await pane.find({ type: "Text", text: "CopySpeech" })).toBeDefined();
  expect(await pane.find({ key: "pane-read" })).toBeDefined();
  expect(await pane.find({ key: "pane-pause" })).toBeUndefined();
  expect(await pane.find({ key: "settings" })).toBeDefined();

  await ui.press({ key: "play-reply-1" });
  await clock.settle();
  await pane.redraw();
  expect(await pane.find({ key: "pane-read" })).toBeUndefined();
  expect(await pane.find({ type: "Text", text: "CopySpeech Reading" })).toBeDefined();
  expect(await pane.find({ key: "pane-pause" })).toBeDefined();
  expect(await pane.find({ key: "pane-stop" })).toBeDefined();
  expect(await pane.find({ key: "settings" })).toBeDefined();

  await pane.press({ key: "pane-pause" });
  await clock.settle();
  expect(urls.some((u) => u.endsWith("/pause"))).toBe(true);
  await pane.unmount();
  await ui.unmount();
});

test("the header Read speaks the latest turn's replies when nothing plays", async ($, on) => {
  const clock = mock.clock(on);
  const bodies: string[] = [];
  on("http.fetch", (_, e) => {
    if (e.url.endsWith("/speak")) bodies.push(JSON.stringify(e.init?.body ?? ""));
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const ui = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: REPLY
  });
  const pane = await $.ui.mount(PANE);
  await pane.press({ key: "pane-read" });
  await clock.settle();
  expect(bodies.some((b) => b.includes("Hello there"))).toBe(true);
  await pane.unmount();
  await ui.unmount();
});

test("Pause stays in the band while the spoken word moves in the pane", async ($, on) => {
  const { playing, other, band, pane, status, clock } = await playHello($, on);
  status.position_ms = 100;
  await clock.advance(250);
  await pane.redraw();
  const word = await pane.find({ type: "Text", text: /^Hello$/ });
  expect(word?.props).toEqual({ backgroundColor: "text", color: "inverseText" });
  await band.redraw();
  expect(await band.find({ key: "pause" })).toBeDefined();
  await pane.unmount();
  await other.unmount();
  await band.unmount();
  await playing.unmount();
});

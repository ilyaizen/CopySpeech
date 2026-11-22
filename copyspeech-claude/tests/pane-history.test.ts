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

test("Settings sits in the pane's header row, collapsed until expanded", async ($, on) => {
  const clock = mock.clock(on);
  const pane = await $.ui.mount(PANE);
  expect(await pane.find({ key: "settings" })).toBeDefined();
  expect(await pane.find({ key: "captions" })).toBeUndefined();
  await pane.press({ key: "settings" });
  await clock.advance(1);
  await pane.redraw();
  expect(await pane.find({ key: "captions" })).toBeDefined();
  await pane.unmount();
});

test("a new Read aloud replaces the reply the pane shows", async ($, on) => {
  const clock = mock.clock(on);
  on("http.fetch", () => ({ value: { status: 200, ok: true, headers: {}, text: "{}" } }));
  const one = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text: "Old message here.", isFirstOfReply: true }
  });
  const two = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-2",
    props: { text: "New message here.", isFirstOfReply: true }
  });
  await one.press({ key: "play-reply-1" });
  await clock.advance(250);
  await two.press({ key: "play-reply-2" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  await pane.redraw();
  expect(await pane.find({ type: "Markdown", text: /Old/ })).toBeUndefined();
  expect(await pane.find({ type: "Markdown", text: /New/ })).toBeDefined();
  await pane.unmount();
  await one.unmount();
  await two.unmount();
});

// The /status fields the reading reads; the app sends a bare { active: false } when idle.
type StatusReport = {
  active: boolean;
  paused?: boolean;
  position_ms?: number;
  fragment_index?: number;
  captions?: {
    text: string;
    words: { text_start: number; text_end: number; start_ms: number; end_ms: number }[];
  };
};

test("a bare inactive status waits out the idle wait before the reading ends", async ($, on) => {
  const clock = mock.clock(on);
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  let status: StatusReport = {
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
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text: "Hello there.", isFirstOfReply: true }
  });
  // Starts the /status poll, which ends the reading.
  await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
  await reply.press({ key: "play-reply-1" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  await pane.redraw();
  expect(await pane.find({ key: "pane-pause" })).toBeDefined();
  status = { active: false };
  await clock.advance(250);
  await pane.redraw();
  // A bare report is also the app's answer after a silent stretch, so the idle wait still applies.
  expect(await pane.find({ key: "pane-pause" })).toBeDefined();
  await clock.advance(2500);
  await pane.redraw();
  expect(await pane.find({ key: "pane-pause" })).toBeUndefined();
  await pane.unmount();
  await reply.unmount();
});

test("a stall while synthesis catches up keeps the reading; a bare inactive status ends it", async ($, on) => {
  const clock = mock.clock(on);
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  let status: StatusReport = {
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
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text: "Hello there.", isFirstOfReply: true }
  });
  await $.session.start({ cwd: ".", surface: "desktop", isInteractive: true });
  await reply.press({ key: "play-reply-1" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  // Synthesis behind playback: the app keeps the last position and reports active false.
  status = { ...status, active: false };
  await clock.advance(5000);
  await pane.redraw();
  expect(await pane.find({ key: "pane-pause" })).toBeDefined();
  // Playback resumes.
  status = { ...status, active: true, position_ms: 900 };
  await clock.advance(250);
  // The app's end: a bare report, then the idle wait.
  status = { active: false };
  await clock.advance(250);
  await pane.redraw();
  expect(await pane.find({ key: "pane-pause" })).toBeDefined();
  await clock.advance(2500);
  await pane.redraw();
  expect(await pane.find({ key: "pane-pause" })).toBeUndefined();
  await pane.unmount();
  await reply.unmount();
});

test("the captions pane keeps the last reading after it stops", async ($, on) => {
  const clock = mock.clock(on);
  let status: StatusReport = {
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
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-1",
    props: { text: "Hello there.", isFirstOfReply: true }
  });
  await reply.press({ key: "play-reply-1" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  status = { active: false };
  await clock.advance(2500);
  await pane.redraw();
  expect(await pane.find({ type: "Markdown", text: /Hello/ })).toBeDefined();
  expect(await pane.find({ type: "Text", text: "Nothing read yet." })).toBeUndefined();
  await pane.unmount();
  await reply.unmount();
});

test("a paragraph's Read button speaks only that paragraph", async ($, on) => {
  const clock = mock.clock(on);
  const bodies: string[] = [];
  on("http.fetch", (_, e) => {
    if (e.url.endsWith("/speak")) bodies.push(JSON.stringify(e.init?.body ?? ""));
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-2",
    props: {
      text: "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.",
      isFirstOfReply: true
    }
  });
  await reply.press({ key: "play-reply-2" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  expect(await pane.find({ type: "Svg" })).toBeDefined();
  // A desktop Read button: the plain word Read, with no icon.
  expect((await pane.find({ key: "read-reply-2-1" }))?.props.label).toBe("Read");
  await pane.press({ key: "read-reply-2-1" });
  await clock.advance(250);
  const last = bodies[bodies.length - 1] ?? "";
  expect(last).toContain("Second paragraph here");
  expect(last).not.toContain("First paragraph");
  expect(last).not.toContain("Third paragraph");
  await pane.unmount();
  await reply.unmount();
});

test("each list item has its own Read button and speaks alone", async ($, on) => {
  const clock = mock.clock(on);
  const bodies: string[] = [];
  on("http.fetch", (_, e) => {
    if (e.url.endsWith("/speak")) bodies.push(JSON.stringify(e.init?.body ?? ""));
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-4",
    props: {
      text: "Pick one.\n\n- First option here.\n- Second option here.\n\nDone.",
      isFirstOfReply: true
    }
  });
  await reply.press({ key: "play-reply-4" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  // The marker is its own Text, with no trailing space for a surface to trim.
  expect(await pane.find({ type: "Text", text: /^•$/ })).toBeDefined();
  // An item row top-aligns its marker and its text, so a wrapped item keeps the marker on its first line.
  const itemRows = (await pane.findAll({ type: "Box" })).filter(
    (box) => box.props.flexDirection === "row" && box.props.alignItems === "flex-start"
  );
  expect(itemRows.length).toBeGreaterThan(0);
  // Block 1 is the list; its items are lines 0 and 1.
  await pane.press({ key: "read-reply-4-1-1" });
  await clock.advance(250);
  const last = bodies[bodies.length - 1] ?? "";
  expect(last).toContain("Second option here");
  expect(last).not.toContain("First option");
  expect(last).not.toContain("Pick one");
  await pane.unmount();
  await reply.unmount();
});

test("a paragraph's Read button on a block with nothing to say keeps the reading", async ($, on) => {
  const clock = mock.clock(on);
  const calls: string[] = [];
  on("http.fetch", (_, e) => {
    calls.push(e.url.slice(e.url.lastIndexOf("/")));
    return { value: { status: 200, ok: true, headers: {}, text: "{}" } };
  });
  const reply = await $.ui.mount({
    plugin: "copyspeech",
    surface: "desktop",
    component: "AssistantMessage",
    requestId: "reply-3",
    props: {
      text: "First paragraph here.\n\n## A heading\n\nThird paragraph here.",
      isFirstOfReply: true
    }
  });
  await reply.press({ key: "play-reply-3" });
  await clock.advance(250);
  const pane = await $.ui.mount(PANE);
  const before = calls.length;
  // Skip sections is on by default, so the heading block has no speech.
  await pane.press({ key: "read-reply-3-1" });
  await clock.advance(250);
  expect(calls.slice(before)).not.toContain("/stop");
  expect(calls.slice(before)).not.toContain("/speak");
  await pane.unmount();
  await reply.unmount();
});

import assert from "node:assert/strict";
import {
  REPLY,
  REPLY_RECT,
  SPEAK_URL,
  announceReply,
  bodyAt,
  clearPlayback,
  fetchUrlText,
  flush,
  freshWorld,
  hooks,
  liveCaptionRun,
  playbackRequestIdNow,
  stopReadingNow,
  test,
  useFakeClock,
  wireRegister
} from "./harness.mjs";

// A /speak that never settles, so the reading stays in flight until a stop aborts it.
// Stop requests resolve only when the test answers them.
function pendingSpeaks(world) {
  const speaks = [];
  globalThis.fetch = (url, options) => {
    const text = fetchUrlText(url);
    if (text === SPEAK_URL) {
      speaks.push({ body: JSON.parse(options.body), signal: options.signal });
      return new Promise(() => {});
    }
    world.fetchUrls.push(text);
    return new Promise((resolve) => {
      world.calls.push({ resolve: () => resolve({ ok: true }) });
    });
  };
  return speaks;
}

test("a stop pressed while a queued read waits on the previous stop cancels that read", async () => {
  const world = freshWorld();
  const speaks = pendingSpeaks(world);
  wireRegister(world, { autoRead: false, captions: false, follow: false });
  hooks.beginRead({ source: "message", root: null, speech: "First reply." });
  await flush();
  assert.equal(speaks.length, 1, "the first read reaches /speak");
  const first = playbackRequestIdNow();
  assert.notEqual(first, null);

  hooks.beginRead({ source: "message", root: null, speech: "Second reply." });
  await flush();
  assert.equal(world.calls.length, 1, "the second read waits on the stop for the first");
  assert.equal(speaks.length, 1, "the second read has not sent /speak yet");

  stopReadingNow();
  await flush();
  for (const call of world.calls) call.resolve();
  await flush();

  assert.equal(speaks.length, 1, "no /speak goes out after the stop");
  assert.equal(speaks[0].signal.aborted, true, "the stopped /speak is aborted");
  assert.equal(playbackRequestIdNow(), null, "the stop leaves no reading and no bar");
  clearPlayback();
});

test("focus moves to another chat: the bar keeps polling without paint, then retires", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  const handlers = wireRegister(world, { autoRead: true, captions: true, follow: false });
  announceReply(handlers, REPLY);
  await world.tick(bodyAt(100));
  world.focus.current = "s2";
  await world.tick(bodyAt(200));
  assert.notEqual(liveCaptionRun(), null, "the run keeps polling");
  assert.equal(world.highlights.size, 0, "no paint in the other chat");
  assert.notEqual(playbackRequestIdNow(), null, "the bar stays while the reading plays");
  await world.tick({ active: false, captions: null });
  await world.tick({ active: false, captions: null });
  assert.equal(liveCaptionRun(), null, "the ended reading stops the run");
  assert.equal(playbackRequestIdNow(), null, "the bar retires with the reading");
  clearPlayback();
});

test("returning to the reply's chat resumes the paint from the current word", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  const handlers = wireRegister(world, { autoRead: true, captions: true, follow: false });
  announceReply(handlers, REPLY);
  await world.tick(bodyAt(100));
  world.focus.current = "s2";
  await world.tick(bodyAt(200));
  assert.equal(world.highlights.size, 0);
  world.focus.current = "s1";
  await world.tick(bodyAt(200));
  assert.equal(world.highlights.size, 1, "the word paints again on return");
  clearPlayback();
});

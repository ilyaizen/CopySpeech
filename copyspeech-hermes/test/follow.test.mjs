import assert from "node:assert/strict";
import {
  FOLLOW_TEXT,
  REPLY,
  REPLY_RECT,
  SPEAK_URL,
  addScrolledReply,
  announceReply,
  bodyAt,
  clearPlayback,
  clock,
  fetchUrlText,
  flush,
  followBody,
  freshWorld,
  liveCaptionRun,
  livePill,
  pillStyle,
  playbackRequestIdNow,
  relayout,
  stopCaptions,
  test,
  useFakeClock,
  wireRegister
} from "./harness.mjs";

test("captions resume after an inactive synthesis stall", async () => {
  useFakeClock();
  const world = freshWorld();
  const reply = world.addReply(REPLY_RECT, REPLY);
  const run = world.startRun();
  await world.tick(bodyAt(100));
  clock.now += 3000;
  await world.tick({ ...bodyAt(100), active: false });
  assert.equal(liveCaptionRun(), run, "inactive status with captions keeps the run");
  await world.tick(bodyAt(500));
  assert.equal(world.highlights.get("copyspeech-word").range.start, 6);
  assert.equal(world.highlights.get("copyspeech-word").range.startContainer, reply.texts[0]);
});

test("an end status clears a matched caption run", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  await world.tick(bodyAt(100));
  // One inactive poll can be a stale report, so an end takes two in a row.
  await world.tick({ active: false });
  assert.notEqual(liveCaptionRun(), null, "one inactive poll keeps the run");
  await world.tick({ active: false });
  assert.equal(liveCaptionRun(), null);
  assert.equal(world.highlights.size, 0);
  assert.equal(world.timers[0].disposed, true);
});

test("an inactive status before the first match does not end the run", async () => {
  useFakeClock();
  const world = freshWorld();
  const run = world.startRun();
  await world.tick({ active: false });
  assert.equal(liveCaptionRun(), run);
  clock.now += 59999;
  await world.tick(null);
  assert.equal(liveCaptionRun(), run);
  clock.now += 1;
  await world.tick(null);
  assert.equal(liveCaptionRun(), null);
});

test("silence stops a matched caption run at 60 seconds", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  const run = world.startRun();
  await world.tick(bodyAt(100));
  clock.now += 59999;
  await world.tick({ ...bodyAt(100), active: false });
  assert.equal(liveCaptionRun(), run);
  clock.now += 1;
  await world.tick({ ...bodyAt(100), active: false });
  assert.equal(liveCaptionRun(), null);
  assert.equal(world.highlights.size, 0);
});

test("follow off: a word out of the band never scrolls and adds no scroller listeners", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = false;
  world.startRun();
  await world.tick(followBody(1500));
  assert.deepEqual(scroller.scrollLog, []);
  assert.equal(scroller.handlers.length, 0);
  assert.equal(world.highlights.size, 1, "captions still paint");
});

test("follow on: a word that leaves the band scrolls its line to the anchor, once", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(100));
  assert.equal(scroller.scrollLog.length, 0, "a word inside the band does not move the view");
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1);
  assert.equal(scroller.scrollLog[0].top, 214, "the line lands on the anchor");
  assert.equal(scroller.scrollLog[0].behavior, "smooth");
  assert.equal(
    world.highlights.get("copyspeech-word").range.startContainer,
    world.replies[0].texts[1]
  );
});

test("follow on: words on a line already in the band do not move the view again", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(1500));
  clock.now += 1000;
  await world.tick(followBody(1950));
  await world.tick(followBody(2450));
  assert.equal(scroller.scrollLog.length, 1, "later words on the moved line do not scroll");
});

test("follow on with captions off: scrolls, paints nothing, and runs one poll", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1);
  assert.equal(world.highlights.size, 0, "no highlight");
  assert.equal(livePill(), null, "no pill");
  assert.equal(liveCaptionRun().mode, "none");
  assert.equal(world.timers.length, 1);
});

test("both off: a finished auto read polls to retire the bar, and paints nothing", async () => {
  useFakeClock();
  const world = freshWorld();
  const handlers = wireRegister(world, { autoRead: true, captions: false, follow: false });
  announceReply(handlers, FOLLOW_TEXT);
  assert.equal(world.timers.length, 1, "one poll runs for the reading");
  assert.equal(liveCaptionRun().mode, "none", "no paint");
  assert.match(playbackRequestIdNow(), /^hermes\./, "the reading carries a request id");
  await world.tick({ active: true, position_ms: 100, fragment_index: 0, captions: null });
  assert.notEqual(playbackRequestIdNow(), null, "the bar stays while the reading plays");
  await world.tick({ active: false, captions: null });
  await world.tick({ active: false, captions: null });
  assert.equal(liveCaptionRun(), null, "two ended reports stop the run");
  assert.equal(playbackRequestIdNow(), null, "the bar retires with the reading");
  assert.equal(world.highlights.size, 0, "no highlight");
  clearPlayback();
});

test("auto-read sends the request id and wait false", () => {
  useFakeClock();
  const world = freshWorld();
  const bodies = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (fetchUrlText(url) === SPEAK_URL) {
      bodies.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true });
    }
    return previousFetch(url, options);
  };
  const handlers = wireRegister(world, { autoRead: true, captions: false, follow: false });
  announceReply(handlers, REPLY);
  globalThis.fetch = previousFetch;
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].request_id, /^hermes\./);
  assert.equal(bodies[0].wait, false);
  clearPlayback();
});

test("a finished auto read retires the playback record", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  const handlers = wireRegister(world, { autoRead: true, captions: true, follow: false });
  announceReply(handlers, REPLY);
  assert.match(playbackRequestIdNow(), /^hermes\./);
  await world.tick(bodyAt(100));
  assert.notEqual(liveCaptionRun(), null, "the run is live while the reading plays");
  await world.tick({ active: false });
  await world.tick({ active: false });
  assert.equal(liveCaptionRun(), null, "the ended status stops the run");
  assert.equal(playbackRequestIdNow(), null, "the bar retires with the reading");
  clearPlayback();
});

test("follow only: speech goes first, one poll starts, and the reply scrolls without paint", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  const handlers = wireRegister(world, { autoRead: true, captions: false, follow: true });
  announceReply(handlers, FOLLOW_TEXT);
  assert.equal(world.fetchUrls[0], SPEAK_URL, "the speech request goes out before any poll");
  assert.equal(world.timers.length, 1, "one poll for follow");
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1);
  assert.equal(world.highlights.size, 0);
});

test("turning follow off mid-run removes the scroller listeners and stops scrolling", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(100));
  assert.equal(scroller.handlers.length, 4, "wheel, touch, scroll keys and scrollbar press");
  world.settings.follow = false;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0);
  assert.equal(scroller.handlers.length, 0);
  world.settings.follow = true;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "turning follow back on scrolls again");
});

test("stopping the run removes the scroller listeners and disposes the poll", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(100));
  assert.equal(scroller.handlers.length, 4);
  stopCaptions();
  assert.equal(scroller.handlers.length, 0);
  assert.equal(world.timers[0].disposed, true);
  assert.equal(liveCaptionRun(), null);
});

test("a focus change stops the run and removes the scroller listeners", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(100));
  world.focus.current = "s2";
  world.poll();
  assert.equal(liveCaptionRun(), null);
  assert.equal(scroller.handlers.length, 0);
});

test("a wheel or touch on the reply pauses follow for five seconds", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  scroller.dispatch("wheel", {});
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0, "the view stays where the reader put it");
  clock.now += 4999;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0, "still paused before five seconds");
  clock.now += 1;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "follow resumes at five seconds");
});

test("a press on the scrollbar pauses follow, a press on a word does not", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  scroller.dispatch("pointerdown", { target: md });
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "a press on a word leaves follow on");
  relayout(md, 0);
  clock.now += 1000;
  scroller.dispatch("pointerdown", { target: scroller });
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "a press on the scrollbar pauses follow");
});

test("scroll keys pause follow, other keys do not", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  scroller.dispatch("keydown", { key: "a" });
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "a letter key leaves follow on");
  relayout(md, 0);
  clock.now += 1000;
  scroller.dispatch("keydown", { key: "ArrowDown" });
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "a scroll key pauses follow");
});

test("follow scrolls at most once per 400 ms", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(1500));
  relayout(md, 0);
  await world.tick(followBody(1950));
  assert.equal(scroller.scrollLog.length, 1, "a second move inside 400 ms waits");
  clock.now += 400;
  await world.tick(followBody(1950));
  assert.equal(scroller.scrollLog.length, 2, "the move follows once the interval passes");
});

test("a gap between words holds the view", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings.follow = true;
  relayout(md, 300);
  world.startRun();
  await world.tick(followBody(1450));
  assert.equal(scroller.scrollLog.length, 0, "the gap after gamma moves nothing");
  await world.tick(followBody(1000));
  assert.equal(scroller.scrollLog.length, 1, "gamma, out of the band, moves the view");
});

test("a status answer for a stopped run does not scroll", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  world.poll();
  stopCaptions();
  world.calls[0].resolve(followBody(1500));
  await flush();
  assert.equal(scroller.scrollLog.length, 0);
});

test("a late status answer from the old chat does not scroll the new chat", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  world.poll();
  world.focus.current = "s2";
  world.calls[0].resolve(followBody(1500));
  await flush();
  assert.equal(scroller.scrollLog.length, 0, "the answer lands after the focus change");
  assert.equal(liveCaptionRun(), null);
  assert.equal(scroller.handlers.length, 0);
});

test("reduced motion: the follow move is an instant jump", async () => {
  useFakeClock();
  const world = freshWorld();
  window.matchMedia = () => ({ matches: true });
  const { scroller } = addScrolledReply(world);
  world.settings.follow = true;
  world.startRun();
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog[0].behavior, "instant");
});

test("captions turned on mid-run paint the current word and keep following", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(1500));
  world.settings.captions = true;
  await world.tick(followBody(1950));
  assert.equal(
    world.highlights.get("copyspeech-word").range.startContainer,
    world.replies[0].texts[1]
  );
  assert.equal(scroller.scrollLog.length, 1, "the reply moved once");
  assert.equal(liveCaptionRun().mode, "plain");
});

test("a touch on a word pauses follow, unlike a mouse press on a word", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  scroller.dispatch("touchstart", { target: md });
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0, "a touch on a word pauses follow");
});

test("a text selection in the reply holds follow until it clears", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller, md } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  const selection = { isCollapsed: false, anchorNode: md, focusNode: md };
  window.getSelection = () => selection;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0, "a selection inside the reply holds the view");
  selection.isCollapsed = true;
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 1, "follow resumes once the selection clears");
});

test("without the Highlight API, plain captions start no run and glide still paints", async () => {
  useFakeClock();
  const world = freshWorld();
  window.CSS = undefined;
  world.addReply(REPLY_RECT, REPLY);
  world.settings = { captions: true, glide: false, follow: false };
  assert.equal(world.startRun(), null, "plain captions need the highlight API");
  world.settings.glide = true;
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(pillStyle().display, "block", "the glide pill paints without the highlight API");
  assert.equal(pillStyle().left, "96px");
});

test("turning follow on mid-reading scrolls from the next status poll", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: true, glide: false, follow: false };
  world.startRun();
  await world.tick(followBody(1500));
  assert.equal(scroller.scrollLog.length, 0, "follow off: the line stays put");
  world.settings.follow = true;
  await world.tick(followBody(1950));
  assert.equal(scroller.scrollLog.length, 1, "follow on: the next poll scrolls the line");
});

test("follow off mid-run with captions off stops the run and removes the wheel listeners", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  assert.equal(scroller.handlers.length, 4);
  world.settings.follow = false;
  world.poll();
  assert.equal(liveCaptionRun(), null, "both toggles off stop the run");
  assert.equal(world.calls.length, 1, "stopping sends no status request");
  assert.equal(scroller.handlers.length, 0, "stopping removes the listeners");
});

test("follow turned on after the run stopped waits for the next reply", async () => {
  useFakeClock();
  const world = freshWorld();
  const { scroller } = addScrolledReply(world);
  world.settings = { captions: false, glide: false, follow: true };
  world.startRun();
  await world.tick(followBody(100));
  world.settings.follow = false;
  world.poll();
  world.settings.follow = true;
  world.poll();
  assert.equal(liveCaptionRun(), null, "nothing restarts the stopped run mid-reading");
  assert.equal(world.calls.length, 1, "no status request after the stop");
  assert.equal(scroller.scrollLog.length, 0, "the view does not move");
});

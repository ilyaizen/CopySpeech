import assert from "node:assert/strict";
import {
  REPLY,
  REPLY_RECT,
  bodyAt,
  createGlidePill,
  fakeEl,
  flush,
  freshWorld,
  liveCaptionRun,
  livePill,
  livePillEnv,
  pillStyle,
  rangeOver,
  test
} from "./harness.mjs";

test("captions paint in the focused chat when another chat is last in the document", async () => {
  const world = freshWorld();
  const focusedReply = world.addReply(REPLY_RECT, REPLY);
  const otherReply = world.addReply(REPLY_RECT, "Unrelated previous assistant response");
  const focusedRoot = { querySelectorAll: () => [focusedReply] };
  const otherRoot = { querySelectorAll: () => [otherReply] };
  const focusedPane = {
    querySelectorAll: (selector) =>
      selector.includes("assistant-message-root") ? [focusedRoot] : []
  };
  const otherPane = {
    querySelectorAll: (selector) => (selector.includes("assistant-message-root") ? [otherRoot] : [])
  };
  focusedPane.dataset = { sessionAnchor: "session-tile:focused" };
  otherPane.dataset = { sessionAnchor: "workspace" };
  globalThis.host.state.focusedStoredSessionId = { get: () => "focused" };
  globalThis.host.state.activeSessionId = { get: () => "other-session" };
  globalThis.document.querySelectorAll = (selector) => {
    if (selector.includes("assistant-message-root")) return [focusedRoot, otherRoot];
    if (selector.includes("data-session-anchor")) return [focusedPane, otherPane];
    return [];
  };
  globalThis.document.querySelector = (selector) => {
    if (selector.includes("session-tile:focused")) return focusedPane;
    if (selector.includes("workspace")) return otherPane;
    return null;
  };
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(
    world.highlights.get("copyspeech-word")?.range.startContainer,
    focusedReply.texts[0],
    "the word is painted in the focused pane, not the document's last pane"
  );
});

test("a caption miss is retried on the next poll, so a reply rendered later still paints", async () => {
  const world = freshWorld();
  const reply = world.addReply(REPLY_RECT, "Unrelated previous assistant response");
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(world.highlights.size, 0, "the first render does not align");
  reply.texts = [{ nodeValue: REPLY, parentElement: reply, isConnected: true, x: 0 }];
  await world.tick(bodyAt(100));
  assert.equal(
    world.highlights.get("copyspeech-word")?.range.startContainer,
    reply.texts[0],
    "the next poll aligns the reply that now renders"
  );
});

test("glide: repeated status ticks on one word do not restart the glide", async () => {
  const world = freshWorld();
  world.settings.glide = true;
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(pillStyle().left, "96px", "first word lands on its rect");
  assert.equal(world.rafCount, 0, "first word does not glide");
  await world.tick(bodyAt(150));
  await world.tick(bodyAt(300));
  assert.equal(world.rafCount, 0, "more ticks on the same word start no glide");
  await world.tick(bodyAt(500));
  assert.equal(world.rafCount, 1, "a new word starts one glide");
  await world.tick(bodyAt(600));
  assert.equal(world.rafCount, 1, "ticks mid-glide on the same word start no glide");
});

test("glide: a held gap keeps the last word painted and stops nothing", async () => {
  const world = freshWorld();
  world.settings.glide = true;
  world.addReply(REPLY_RECT, REPLY);
  const run = world.startRun();
  await world.tick(bodyAt(100));
  await world.tick(bodyAt(420));
  assert.equal(pillStyle().left, "96px", "the pill holds its word in the gap");
  assert.equal(liveCaptionRun(), run, "a gap does not stop the run");
  assert.equal(world.rafCount, 0, "a gap starts no glide");
  await world.tick(bodyAt(500));
  assert.equal(world.rafCount, 1, "the next word glides from the held place");
});

test("stale response after a focus change does not paint", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  world.poll();
  world.focus.current = "s2";
  world.calls[0].resolve(bodyAt(100));
  await flush();
  assert.equal(world.highlights.size, 0, "no highlight from the old chat");
  assert.equal(livePill(), null, "no pill from the old chat");
  assert.equal(liveCaptionRun(), null, "the run stops");
});

test("stale response after captions turn off does not paint", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  world.poll();
  world.settings.captions = false;
  world.calls[0].resolve(bodyAt(100));
  await flush();
  assert.equal(world.highlights.size, 0);
  assert.equal(livePill(), null);
  assert.equal(liveCaptionRun(), null);
});

test("a focus change during a pending request stops the run without a new request", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  world.poll();
  world.focus.current = "s2";
  world.poll();
  assert.equal(world.calls.length, 1, "no second request while the first is pending");
  assert.equal(liveCaptionRun(), null, "the poll saw the focus change despite the pending request");
  world.calls[0].resolve(bodyAt(100));
  await flush();
  assert.equal(world.highlights.size, 0, "the late answer paints nothing");
});

test("a stale response from a replaced run does not stop the replacement", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun("s1");
  world.poll();
  world.focus.current = "s2";
  const replacement = world.startRun("s2");
  world.calls[0].resolve(bodyAt(100));
  await flush();
  assert.equal(
    liveCaptionRun(),
    replacement,
    "the old run's late answer leaves the replacement alive"
  );
  assert.equal(world.highlights.size, 0);
  const sent = world.calls.length;
  world.poll(0);
  assert.equal(world.calls.length, sent, "the disposed old run sends no request");
});

test("a glide change during a pending request paints in the new mode", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  const run = world.startRun();
  world.poll();
  world.settings.glide = true;
  world.calls[0].resolve(bodyAt(100));
  await flush();
  assert.equal(run.mode, "glide", "the run switched before it painted");
  assert.equal(world.highlights.size, 0, "no CSS highlight in glide mode");
  assert.equal(pillStyle().left, "96px", "the pill paints the word");
});

test("switch mode: plain to glide and back repaints the word in each mode", async () => {
  const world = freshWorld();
  world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(
    world.highlights.has("copyspeech-word"),
    true,
    "plain mode paints the CSS highlight"
  );
  world.settings.glide = true;
  world.poll();
  assert.equal(world.highlights.size, 0, "switching to glide clears the highlight");
  assert.equal(pillStyle().left, "96px", "switching to glide shows the pill on the same word");
  world.calls[world.calls.length - 1].resolve(bodyAt(500));
  await flush();
  assert.equal(world.rafCount, 1, "the next word glides in glide mode");
  world.settings.glide = false;
  await world.tick(bodyAt(500));
  assert.equal(livePill(), null, "switching back destroys the pill");
  assert.equal(
    world.highlights.has("copyspeech-word"),
    true,
    "plain mode paints the highlight again"
  );
});

test("glide: a scroll mid-glide does not jump the pill, and the glide lands on the moved word", async () => {
  const world = freshWorld();
  world.settings.glide = true;
  const reply = world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  await world.tick(bodyAt(100));
  await world.tick(bodyAt(500));
  world.stepOnce(1000);
  world.stepOnce(1016);
  const midGlide = pillStyle().left;
  assert.ok(parseFloat(midGlide) > 96 && parseFloat(midGlide) < 144, "the pill is mid-glide");
  reply.rect.left -= 30; // the chat scrolls left under the word
  world.dispatch("scroll");
  assert.equal(pillStyle().left, midGlide, "a scroll mid-glide leaves the pill where it is");
  world.stepFrames(1032);
  assert.equal(pillStyle().left, "114px", "the glide lands on the word's new place");
});

test("clip: a word is cut by a hidden ancestor above a visible one, and by a nearer auto box", async () => {
  const world = freshWorld();
  const outer = world.body.appendChild(fakeEl({ left: 100, top: 100, width: 200, height: 100 }));
  outer.overflowX = "hidden";
  const middle = outer.appendChild(fakeEl({ left: 100, top: 100, width: 400, height: 100 }));
  const inner = middle.appendChild(fakeEl({ left: 100, top: 100, width: 400, height: 100 }));
  inner.overflowX = "auto";
  const para = inner.appendChild(fakeEl({ left: 280, top: 100, width: 40, height: 20 }));
  para.texts = [{ nodeValue: "abcde", parentElement: para, isConnected: true, x: 0 }];
  // The word spans 280..320 and pads to 276..324. The hidden outer box ends at 300.
  const rect = livePillEnv().measure(rangeOver(para.texts[0], 0, 5));
  assert.deepEqual(rect, { left: 276, top: 100, width: 24, height: 18 });
});

test("clip: every drawn glide frame stays inside the target word's clip", async () => {
  const world = freshWorld();
  const wide = world.body.appendChild(fakeEl({ left: 100, top: 100, width: 300, height: 100 }));
  wide.overflowX = "hidden";
  const paraA = wide.appendChild(fakeEl({ left: 100, top: 100, width: 300, height: 20 }));
  paraA.texts = [{ nodeValue: "wordA", parentElement: paraA, isConnected: true, x: 280 }];
  const narrow = world.body.appendChild(fakeEl({ left: 100, top: 300, width: 100, height: 100 }));
  narrow.overflowX = "hidden";
  const paraB = narrow.appendChild(fakeEl({ left: 100, top: 300, width: 100, height: 20 }));
  paraB.texts = [{ nodeValue: "wordB", parentElement: paraB, isConnected: true, x: 80 }];
  // Word A clips at x 400, word B at x 200. The glide starts in A's clip and must not paint past 200.
  const pill = createGlidePill(livePillEnv());
  pill.move(rangeOver(paraA.texts[0], 0, 5));
  pill.move(rangeOver(paraB.texts[0], 0, 5));
  const style = pill.element().style;
  let steps = 0;
  while (world.frames.length > 0) {
    world.stepOnce(1000 + steps * 16);
    steps += 1;
    assert.ok(steps < 200, "glide must end");
    if (style.display !== "none") {
      const left = parseFloat(style.left);
      const right = left + parseFloat(style.width);
      assert.ok(
        left >= 100 && right <= 200,
        "frame " + steps + " stays in the clip: " + left + ".." + right
      );
    }
  }
  assert.ok(steps >= 3, "the glide drew several frames");
  assert.equal(style.left, "176px");
  assert.equal(style.width, "24px");
});

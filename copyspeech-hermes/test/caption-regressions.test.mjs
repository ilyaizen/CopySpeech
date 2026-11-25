import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  REPLY,
  REPLY_RECT,
  bodyAt,
  clock,
  freshWorld,
  liveCaptionRun,
  test,
  tokenLive,
  tokenRange,
  tokensFromRange,
  useFakeClock
} from "./harness.mjs";

// Regressions behind the lost and crashing captions on auto-read. Each test fails on the
// code before its fix.

test("an auto read keeps its highlight in the reply it pinned when a newer reply streams", async () => {
  const world = freshWorld();
  const done = world.addReply(REPLY_RECT, REPLY);
  const streaming = world.addReply(REPLY_RECT, "A newer answer is still streaming");
  world.roots = [
    { querySelectorAll: () => [done], isConnected: true },
    { querySelectorAll: () => [streaming], isConnected: true }
  ];
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(world.highlights.get("copyspeech-word")?.range.startContainer, done.texts[0]);
  await world.tick(bodyAt(500));
  assert.equal(
    world.highlights.get("copyspeech-word")?.range.startContainer,
    done.texts[0],
    "the next word stays in the completed reply, not the streaming one"
  );
});

test("a text node whose words changed in place drops its highlight and throws nothing", async () => {
  const world = freshWorld();
  const reply = world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  await world.tick(bodyAt(100));
  assert.equal(world.highlights.size, 1, "the first word paints");
  // Markdown rewrites the node's text in place, so the old offsets no longer fit.
  reply.texts[0].nodeValue = "Hi";
  await world.tick(bodyAt(500));
  assert.equal(world.highlights.size, 0, "the stale word is not painted");
  assert.notEqual(liveCaptionRun(), null, "the run keeps polling");
});

test("a paint error drops the alignment, and the next poll paints again", async () => {
  const world = freshWorld();
  const reply = world.addReply(REPLY_RECT, REPLY);
  world.startRun();
  world.highlights.set = () => {
    throw new Error("paint refused");
  };
  await world.tick(bodyAt(100));
  assert.notEqual(liveCaptionRun(), null, "the run survives the error");
  delete world.highlights.set;
  await world.tick(bodyAt(100));
  assert.equal(
    world.highlights.get("copyspeech-word")?.range.startContainer,
    reply.texts[0],
    "the next poll aligns and paints"
  );
});

test("a live reading whose words do not align keeps its run past 60 seconds", async () => {
  useFakeClock();
  const world = freshWorld();
  world.addReply(REPLY_RECT, "Unrelated words only");
  const run = world.startRun();
  for (let step = 0; step < 8; step += 1) {
    clock.now += 10000;
    await world.tick(bodyAt(100));
  }
  assert.equal(liveCaptionRun(), run, "80 seconds of live reports keep the run");
  // Two inactive reports after live ones end the reading.
  await world.tick({ active: false });
  await world.tick({ active: false });
  assert.equal(liveCaptionRun(), null, "the end reports stop the run");
});

test("a code word split across text nodes ends in its last node", () => {
  const dom = new JSDOM("<p>Use <code><span>keep</span><span>_mark</span></code> here</p>");
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  const paragraph = dom.window.document.querySelector("p");
  const range = dom.window.document.createRange();
  range.selectNodeContents(paragraph);
  const tokens = tokensFromRange(range, new Set(["keepmark", "use", "here"]));
  const merged = tokens.find((token) => token.norm === "keepmark");
  assert.ok(merged, "the split word merges into one token");
  assert.equal(tokenRange(merged).toString(), "keep_mark", "the range covers the whole word");
  assert.equal(tokenLive(merged), true);
  dom.window.close();
});

import assert from "node:assert/strict";
import {
  VIEW,
  box,
  clipper,
  createGlidePill,
  finishGlide,
  leftOf,
  measureWord,
  pillHarness,
  plainStyle,
  pollPlan,
  runOf,
  scrollStyle,
  test,
  wordAt
} from "./harness.mjs";

test("glide pill: first word lands on its rect with no CSS transition", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  pill.move(wordAt(10, 20, 40, 16));
  const style = pill.element().style;
  assert.equal(style.left, "10px");
  assert.equal(style.top, "20px");
  assert.equal(style.width, "40px");
  assert.equal(style.height, "16px");
  assert.equal(style.mixBlendMode, "difference");
  assert.equal(style.transition, undefined);
  assert.equal(h.pending(), 0);
  assert.equal(h.attached.size, 1);
});

test("glide pill: a moved word glides over several frames and lands exactly", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(wordAt(100, 0, 60, 20));
  const lefts = [];
  let at = 1000;
  while (h.pending() > 0) {
    assert.equal(h.pending(), 1, "one frame request at a time");
    h.step(at);
    lefts.push(leftOf(pill));
    at += 16;
    assert.ok(lefts.length < 100, "glide must end");
  }
  assert.ok(lefts.length >= 3, "glide spans several frames");
  assert.equal(lefts[0], 0);
  for (let i = 1; i < lefts.length; i += 1)
    assert.ok(lefts[i] >= lefts[i - 1], "left never moves back");
  assert.equal(lefts[lefts.length - 1], 100);
  assert.equal(pill.element().style.width, "60px");
  assert.equal(pill.moving(), false);
});

test("glide pill: a new word mid-glide starts from the drawn place", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(wordAt(100, 0, 60, 20));
  h.step(1000);
  h.step(1016);
  const drawn = leftOf(pill);
  assert.ok(drawn > 0 && drawn < 100, "pill is mid-glide");
  pill.move(wordAt(300, 0, 60, 20));
  assert.equal(h.pending(), 1, "retarget keeps a single frame request");
  h.step(1032);
  assert.equal(leftOf(pill), drawn, "first frame of the retarget is the drawn place");
  finishGlide(h, 1048);
  assert.equal(leftOf(pill), 300);
});

test("glide pill: a scroll during a glide lands on the moved word", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  const word = wordAt(100, 0, 60, 20);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(word);
  h.step(1000);
  h.step(1016);
  word.rect.left = 130;
  pill.reposition();
  assert.equal(h.pending(), 1, "reposition leaves the running loop to read the live rect");
  finishGlide(h, 1032);
  assert.equal(leftOf(pill), 130);
});

test("glide pill: a scroll while idle repaints at the word's new place", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  const word = wordAt(100, 0, 60, 20);
  pill.move(word);
  word.rect.top = 50;
  pill.reposition();
  assert.equal(pill.element().style.top, "50px");
  assert.equal(h.pending(), 0);
});

test("glide pill: a finished glide schedules no further frames", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(wordAt(100, 0, 60, 20));
  finishGlide(h, 1000);
  for (let i = 0; i < 5; i += 1) h.step(2000 + i * 16);
  assert.equal(leftOf(pill), 100);
  assert.equal(h.pending(), 0, "the loop stops when the glide ends");
});

test("glide pill: destroy mid-glide cancels the frame and removes element and listeners", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(wordAt(100, 0, 60, 20));
  h.step(1000);
  assert.equal(h.listeners.size, 2, "scroll and resize listeners");
  pill.destroy();
  assert.equal(h.pending(), 0);
  assert.equal(h.attached.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(pill.element(), null);
  assert.equal(pill.moving(), false);
});

test("glide pill: reduced motion moves the pill in one step", () => {
  const h = pillHarness(true);
  const pill = createGlidePill(h.env);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(wordAt(100, 0, 60, 20));
  assert.equal(h.pending(), 0);
  assert.equal(leftOf(pill), 100);
});

test("glide pill: a word scrolled out of its port hides the pill and stops the loop", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  const word = wordAt(100, 0, 60, 20);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(word);
  h.step(1000);
  word.rect = null;
  h.step(1016);
  assert.equal(pill.element().style.display, "none");
  assert.equal(h.pending(), 0);
  word.rect = box(100, 0, 60, 20);
  pill.reposition();
  assert.equal(pill.element().style.display, "block");
  assert.equal(leftOf(pill), 100);
});

test("glide pill: a word removed from the page destroys the pill mid-glide", () => {
  const h = pillHarness();
  const pill = createGlidePill(h.env);
  const word = wordAt(100, 0, 60, 20);
  pill.move(wordAt(0, 0, 50, 20));
  pill.move(word);
  h.step(1000);
  word.startContainer.isConnected = false;
  h.step(1016);
  assert.equal(h.attached.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.pending(), 0);
  assert.equal(pill.element(), null);
});

test("measureWord pads the first painted rect", () => {
  const range = {
    startContainer: { parentElement: null },
    getClientRects: () => [box(10, 10, 40, 16)]
  };
  assert.deepEqual(measureWord(range, plainStyle, VIEW), {
    left: 6,
    top: 8,
    width: 48,
    height: 20
  });
});

test("measureWord cuts the word to its scroll port", () => {
  const port = clipper("auto", box(0, 12, 500, 300));
  const range = {
    startContainer: { parentElement: port },
    getClientRects: () => [box(10, 10, 40, 16)]
  };
  assert.deepEqual(measureWord(range, scrollStyle, VIEW), {
    left: 6,
    top: 12,
    width: 48,
    height: 16
  });
});

test("measureWord skips ancestors that do not clip", () => {
  const port = clipper("scroll", box(0, 0, 500, 9));
  const plain = { parentElement: port, overflow: "visible" };
  const range = {
    startContainer: { parentElement: plain },
    getClientRects: () => [box(10, 10, 40, 16)]
  };
  assert.deepEqual(measureWord(range, scrollStyle, VIEW), {
    left: 6,
    top: 8,
    width: 48,
    height: 1
  });
});

test("measureWord returns null when the word is scrolled out of its port", () => {
  const port = clipper("auto", box(0, 40, 500, 300));
  const range = {
    startContainer: { parentElement: port },
    getClientRects: () => [box(10, 10, 40, 16)]
  };
  assert.equal(measureWord(range, scrollStyle, VIEW), null);
});

test("measureWord cuts a word at the viewport edge", () => {
  const range = {
    startContainer: { parentElement: null },
    getClientRects: () => [box(10, -10, 40, 16)]
  };
  assert.deepEqual(measureWord(range, plainStyle, VIEW), { left: 6, top: 0, width: 48, height: 8 });
});

test("measureWord returns null when the word has no painted rect", () => {
  const range = { startContainer: { parentElement: null }, getClientRects: () => [] };
  assert.equal(measureWord(range, plainStyle, VIEW), null);
});

test("pollPlan stops when captions are off", () => {
  assert.equal(pollPlan(runOf, { captions: false, glide: false }, "s1"), "stop");
});

test("pollPlan stops when focus moves to another session", () => {
  assert.equal(pollPlan(runOf, { captions: true, glide: false }, "s2"), "stop");
});

test("pollPlan switches paint mode when the glide setting flips", () => {
  assert.equal(pollPlan(runOf, { captions: true, glide: true }, "s1"), "switch");
});

test("pollPlan keeps the run when nothing changed", () => {
  assert.equal(pollPlan(runOf, { captions: true, glide: false }, "s1"), "keep");
});

test("pollPlan keeps a follow-only run with captions off", () => {
  const run = { sessionId: "s1", mode: "none" };
  assert.equal(pollPlan(run, { captions: false, glide: false, follow: true }, "s1"), "keep");
});

test("pollPlan stops when captions and follow are both off", () => {
  assert.equal(pollPlan(runOf, { captions: false, glide: false, follow: false }, "s1"), "stop");
});

test("pollPlan switches a follow-only run when captions turn on", () => {
  const run = { sessionId: "s1", mode: "none" };
  assert.equal(pollPlan(run, { captions: true, glide: false, follow: true }, "s1"), "switch");
});

test("pollPlan keeps a controlled run alive with every paint switch off", () => {
  const run = { sessionId: "s1", mode: "none", controlled: true };
  assert.equal(pollPlan(run, { captions: false, glide: false, follow: false }, "s1"), "keep");
});

test("pollPlan keeps a selection read painting with captions off", () => {
  const run = { sessionId: "s1", mode: "plain", forceCaptions: true };
  assert.equal(pollPlan(run, { captions: false, glide: false, follow: false }, "s1"), "keep");
});

test("pollPlan switches a selection read to the pill when glide turns on", () => {
  const run = { sessionId: "s1", mode: "plain", forceCaptions: true };
  assert.equal(pollPlan(run, { captions: true, glide: true, follow: false }, "s1"), "switch");
});

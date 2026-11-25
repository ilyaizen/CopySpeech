import assert from "node:assert/strict";
import {
  activeWordIndex,
  alignDetail,
  captionOf,
  captionWords,
  norms,
  test,
  wordEntries,
  wordTokens
} from "./harness.mjs";

test("wordTokens splits letters and digits and drops punctuation", () => {
  assert.deepEqual(norms(wordTokens("Don't stop, 42 times!")), ["don", "t", "stop", "42", "times"]);
});

test("captionWords keeps plain word-level timings", () => {
  const caption = captionOf(
    "Hello there.",
    wordEntries("Hello there.", [
      [0, 5, 0, 400],
      [6, 11, 450, 900]
    ])
  );
  assert.deepEqual(captionWords(caption), [
    { norm: "hello", start_ms: 0, end_ms: 400 },
    { norm: "there", start_ms: 450, end_ms: 900 }
  ]);
});

test("captionWords keeps a trailing punctuation mark inside the word timing", () => {
  const caption = captionOf(
    "Hi, you",
    wordEntries("Hi, you", [
      [0, 3, 0, 300],
      [4, 7, 350, 600]
    ])
  );
  assert.deepEqual(captionWords(caption), [
    { norm: "hi", start_ms: 0, end_ms: 300 },
    { norm: "you", start_ms: 350, end_ms: 600 }
  ]);
});

test("captionWords groups per-character entries under each word", () => {
  const text = "Hi you";
  const chars = [
    [0, 1, 0, 100],
    [1, 2, 100, 200],
    [2, 3, 200, 250],
    [3, 4, 250, 300],
    [4, 5, 300, 350],
    [5, 6, 350, 400]
  ];
  assert.deepEqual(captionWords(captionOf(text, wordEntries(text, chars))), [
    { norm: "hi", start_ms: 0, end_ms: 200 },
    { norm: "you", start_ms: 250, end_ms: 400 }
  ]);
});

test("captionWords skips a word that has no timing", () => {
  const caption = captionOf("Hi you", wordEntries("Hi you", [[0, 2, 0, 200]]));
  assert.deepEqual(captionWords(caption), [{ norm: "hi", start_ms: 0, end_ms: 200 }]);
});

test("activeWordIndex holds -1 in a gap between words", () => {
  const words = [
    { norm: "a", start_ms: 0, end_ms: 100 },
    { norm: "b", start_ms: 150, end_ms: 250 }
  ];
  assert.equal(activeWordIndex(words, 50), 0);
  assert.equal(activeWordIndex(words, 120), -1);
  assert.equal(activeWordIndex(words, 200), 1);
  assert.equal(activeWordIndex(words, 999), -1);
});

test("alignDetail maps plain words in order", () => {
  const tokens = wordTokens("The quick brown fox.");
  const words = [
    { norm: "the", start_ms: 0, end_ms: 1 },
    { norm: "quick", start_ms: 1, end_ms: 2 },
    { norm: "brown", start_ms: 2, end_ms: 3 },
    { norm: "fox", start_ms: 3, end_ms: 4 }
  ];
  const detail = alignDetail(words, tokens, 0);
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.map, [0, 1, 2, 3]);
});

test("alignDetail does not anchor a common word inside a skipped excerpt gap", () => {
  // Top + bottom excerpt: the caption skips the middle paragraph. "the" appears
  // inside the skipped gap, close enough to match, but the bottom's "the model"
  // run only follows the later occurrence.
  const filler = Array.from({ length: 30 }, (_, i) => "filler" + i).join(" ");
  const text = "alpha beta the cat sat in a box " + filler + " the model is good";
  const tokens = wordTokens(text);
  const bottomThe = tokens.map((t) => t.norm).lastIndexOf("the");
  const words = [
    { norm: "alpha", start_ms: 0, end_ms: 1 },
    { norm: "beta", start_ms: 1, end_ms: 2 },
    { norm: "the", start_ms: 2, end_ms: 3 },
    { norm: "model", start_ms: 3, end_ms: 4 },
    { norm: "is", start_ms: 4, end_ms: 5 },
    { norm: "good", start_ms: 5, end_ms: 6 }
  ];
  const detail = alignDetail(words, tokens, 0);
  assert.equal(detail.ok, true);
  assert.equal(detail.map[2], bottomThe);
  assert.equal(detail.map[3], bottomThe + 1);
});

test("alignDetail ignores case and punctuation in the rendered text", () => {
  const tokens = wordTokens("**Hello**, World!");
  const words = [
    { norm: "hello", start_ms: 0, end_ms: 1 },
    { norm: "world", start_ms: 1, end_ms: 2 }
  ];
  const detail = alignDetail(words, tokens, 0);
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.map, [0, 1]);
});

test("alignDetail resyncs across an excerpt gap", () => {
  const filler = Array.from({ length: 40 }, (_, i) => "filler" + i).join(" ");
  const tokens = wordTokens("alpha beta gamma " + filler + " delta epsilon zeta eta theta");
  const first = [
    { norm: "alpha", start_ms: 0, end_ms: 1 },
    { norm: "beta", start_ms: 1, end_ms: 2 },
    { norm: "gamma", start_ms: 2, end_ms: 3 }
  ];
  const a = alignDetail(first, tokens, 0);
  assert.equal(a.ok, true);
  assert.deepEqual(a.map, [0, 1, 2]);
  const second = ["delta", "epsilon", "zeta", "eta", "theta"].map((norm, i) => ({
    norm,
    start_ms: i,
    end_ms: i + 1
  }));
  const b = alignDetail(second, tokens, a.cursor);
  assert.equal(b.ok, true);
  assert.deepEqual(b.map, [43, 44, 45, 46, 47]);
});

test("alignDetail does not anchor on a common word without a following run", () => {
  const filler = Array.from({ length: 30 }, (_, i) => "x" + i).join(" ");
  const tokens = wordTokens("the " + filler + " the cat sat");
  const words = ["the", "cat", "sat"].map((norm, i) => ({ norm, start_ms: i, end_ms: i + 1 }));
  const detail = alignDetail(words, tokens, 0);
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.map, [31, 32, 33]);
});

test("alignDetail rejects text that is not in the reply", () => {
  const tokens = wordTokens("Completely different sentence about cats and dogs.");
  const words = ["red", "green", "blue", "yellow"].map((norm, i) => ({
    norm,
    start_ms: i,
    end_ms: i + 1
  }));
  assert.equal(alignDetail(words, tokens, 0).ok, false);
});

test("alignDetail rejects text when under half the words map", () => {
  const tokens = wordTokens("one two");
  const words = ["one", "x", "y", "z"].map((norm, i) => ({ norm, start_ms: i, end_ms: i + 1 }));
  assert.equal(alignDetail(words, tokens, 0).ok, false);
});

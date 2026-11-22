import { expect, test } from "claude-code/testing";

import {
  align,
  applyOverrides,
  captionWords,
  pickParagraphs,
  prepareLine,
  prepareSpeech,
  speakable,
  wordTokens
} from "../hooks/register";

test("excerpt keeps top and bottom paragraphs, as Hermes does", async () => {
  const paras = ["a", "b", "c", "d", "e"];
  expect(pickParagraphs(paras, { mode: "both", top: 2, bottom: 2 })).toEqual(["a", "b", "d", "e"]);
  expect(pickParagraphs(paras, { mode: "top", top: 1, bottom: 9 })).toEqual(["a"]);
  expect(pickParagraphs(paras, { mode: "bottom", top: 9, bottom: 1 })).toEqual(["e"]);
  expect(pickParagraphs(paras, { mode: "both", top: 3, bottom: 2 })).toEqual(paras);
  expect(pickParagraphs(paras, { mode: "both", top: 0, bottom: 99 })).toEqual(paras);
});

test("skip drops headings, items, rules, and table rows but keeps text under a heading", async () => {
  const md = "## Answer\nYes it works.\n\n- one\n1. two\n---\n| a | b |\nDone.";
  expect(prepareSpeech([{ row: "r", md }], true, null).speech).toBe("Yes it works.\n\nDone.");
  expect(prepareSpeech([{ row: "r", md: "- one\n- two" }], false, null).speech).toBe("one\ntwo");
});

test("prepareLine speaks one list item from its own range, with the reply's offsets", async () => {
  const md = "Pick one:\n\n- first item here\n- second item here";
  const phrase = "second item here";
  const from = md.indexOf(phrase);
  const spoken = prepareLine("r", md, from, from + phrase.length);
  expect(spoken.speech).toBe(phrase);
  expect(spoken.tokens.map((t) => md.slice(t.start, t.end))).toEqual(["second", "item", "here"]);
  expect(spoken.tokens.every((t) => t.row === "r")).toBe(true);
});

const MD = "The **quick** fox. Run `npm test` then [read docs](https://x.y/z) now.";

test("speakable reads inline code and link text, and skips link targets", async () => {
  const { tokens, speech } = speakable(MD);
  expect(tokens.map((t) => t.norm)).toEqual([
    "the",
    "quick",
    "fox",
    "run",
    "npm",
    "test",
    "then",
    "read",
    "docs",
    "now"
  ]);
  expect(speech).toBe("The quick fox. Run npm test then read docs now.");
});

test("speakable skips fenced code blocks of both fence kinds", async () => {
  const md =
    "Before.\n\n```ts\nconst hidden = 1;\n```\n\nMid `kept`.\n\n~~~\nalso hidden\n~~~\n\nAfter.";
  const { tokens, speech } = speakable(md);
  expect(tokens.map((t) => t.norm)).toEqual(["before", "mid", "kept", "after"]);
  expect(speech).not.toContain("hidden");
  expect(speech).toContain("Mid kept.");
});

test("speakable says a dot in inline code as the word dot, and captions still align", async () => {
  const md = "Open `export.ts` now. Prose export.ts and `3.14` stay.";
  const { tokens, speech } = speakable(md);
  expect(speech).toBe("Open export dot ts now. Prose export.ts and 3.14 stay.");
  const dot = tokens.find((t) => t.norm === "dot");
  expect(dot).toBeDefined();
  if (dot === undefined) return;
  expect(md.slice(dot.start, dot.end)).toBe(".");
  expect(tokens.map((t) => t.norm)).toEqual(wordTokens(speech).map((t) => t.norm));
  expect(align(captionWords(captionFor(speech)), tokens, 0).ok).toBe(true);
});

// One caption entry per spoken word, 300 ms each, as CopySpeech sends them.
function captionFor(speech: string) {
  return {
    text: speech,
    words: wordTokens(speech).map((t, i) => ({
      text_start: t.start,
      text_end: t.end,
      start_ms: i * 300,
      end_ms: i * 300 + 300
    }))
  };
}

const LONG = [
  "## Plan",
  "",
  "- Read the file",
  "- Check the output",
  "",
  "Run the build first. It takes a while.",
  "",
  "Then open the log and read every line of the output for the warnings, the errors, and the timing numbers that the build prints at the end.",
  "",
  "Finally, report the result to the user."
].join("\n");

test("captions align to the spoken words across a heading, a list, and an excerpt gap", async () => {
  const spoken = prepareSpeech([{ row: "reply", md: LONG }], true, {
    mode: "both",
    top: 1,
    bottom: 1
  });
  expect(spoken.speech).toBe(
    "Run the build first. It takes a while.\n\nFinally, report the result to the user."
  );
  // Tokens are exactly the spoken words, and each offset points at its word in the markdown.
  expect(spoken.tokens.map((t) => t.norm)).toEqual(wordTokens(spoken.speech).map((t) => t.norm));
  for (const t of spoken.tokens) {
    expect(LONG.slice(t.start, t.end).toLowerCase()).toBe(t.norm);
    expect(t.row).toBe("reply");
  }
  const words = captionWords(captionFor(spoken.speech));
  const a = align(words, spoken.tokens, 0);
  expect(a.ok).toBe(true);
  words.forEach((w, i) => expect(spoken.tokens[a.map[i] ?? -1]?.norm).toBe(w.norm));
});

test("a setting override holds until the plugin loads a value other than the one it replaced", () => {
  const loaded = {
    autoRead: false,
    skipSections: true,
    excerpt: true,
    excerptMode: "both",
    excerptTop: 2,
    excerptBottom: 2,
    captions: true
  };
  const overrides = { autoRead: { from: false, to: true } };
  expect(applyOverrides(loaded, overrides).autoRead).toBe(true);
  // Once the plugin loads another value, the override is retired and the loaded value wins.
  const stale = { autoRead: { from: false, to: false } };
  expect(applyOverrides({ ...loaded, autoRead: true }, stale).autoRead).toBe(true);
  // A bare value from an older build never holds.
  // SAFETY: the old state shape, written before overrides carried `from`.
  expect(applyOverrides(loaded, { autoRead: true } as never).autoRead).toBe(false);
});

test("skip drops a list item's wrapped lines and nested items, and keeps code with no item whole", async () => {
  const md = "Intro.\n\n- item one\n  wraps here\n    - nested item\n\nOutro.";
  expect(prepareSpeech([{ row: "r", md }], true, null).speech).toBe("Intro.\n\nOutro.");
  const code = "Run:\n\n```\n- not an item\nstill code\n```\n\nDone.";
  expect(prepareSpeech([{ row: "r", md: code }], true, null).speech).toBe("Run:\n\nDone.");
});

test("a one-word fragment gets the chip on the next token", async () => {
  const spoken = prepareSpeech([{ row: "r", md: "Summary\n\nAll tests pass." }], false, null);
  const a = align(captionWords(captionFor("Summary")), spoken.tokens, 0);
  expect(a.ok).toBe(true);
  expect(a.map).toEqual([0]);
  // Far from the cursor, one word does not anchor: it may be a common word in an excerpt gap.
  expect(align(captionWords(captionFor("pass")), spoken.tokens, 0).ok).toBe(false);
});

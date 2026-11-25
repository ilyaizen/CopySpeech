import assert from "node:assert/strict";
import {
  ON,
  barStateFor,
  clampCount,
  dropSkippedMarkup,
  excerptSpeech,
  happyEvent,
  happyState,
  markup,
  normalizeSettings,
  para,
  prepareSpeech,
  speakVerdict,
  speechForRead,
  test,
  toSpeech,
  withClaim
} from "./harness.mjs";

test("excerpt both keeps first and last paragraph", () => {
  assert.equal(excerptSpeech(para, "both", 1, 1), "a\n\nd");
});

test("excerpt top keeps first two paragraphs", () => {
  assert.equal(excerptSpeech(para, "top", 2, 2), "a\n\nb");
});

test("excerpt bottom keeps last two paragraphs", () => {
  assert.equal(excerptSpeech(para, "bottom", 2, 2), "c\n\nd");
});

test("excerpt returns short text unchanged", () => {
  assert.equal(excerptSpeech("one block only", "both", 1, 1), "one block only");
});

test("message read keeps top two and bottom two of five paragraphs", () => {
  const five = "one\n\ntwo\n\nthree\n\nfour\n\nfive";
  assert.equal(speechForRead("message", five, ON), "one\n\ntwo\n\nfour\n\nfive");
});

test("message read reads in full when excerpt is off", () => {
  const five = "one\n\ntwo\n\nthree\n\nfour\n\nfive";
  assert.equal(speechForRead("message", five, { ...ON, excerpt: false }), five);
});

test("selection read ignores excerpt settings and reads in full", () => {
  const five = "one\n\ntwo\n\nthree\n\nfour\n\nfive";
  assert.equal(speechForRead("selection", five, ON), five);
});

test("dropSkippedMarkup removes headings, bullets, numbered items, rules, and table rows", () => {
  assert.equal(
    dropSkippedMarkup(markup),
    ["", "Intro line.", "", "", "", "", "", "Closing."].join("\n")
  );
});

test("dropSkippedMarkup keeps bold text, hashtags, and dashes inside a sentence", () => {
  assert.equal(
    dropSkippedMarkup("**Bold** start\n#tag here\n-5 degrees\nA - B"),
    "**Bold** start\n#tag here\n-5 degrees\nA - B"
  );
});

test("prepareSpeech with skip on reads the text under a heading and drops the list", () => {
  assert.equal(
    prepareSpeech(markup, { excerpt: false, skipMarkdownSections: true }),
    "Intro line.\n\nClosing."
  );
});

test("prepareSpeech with skip off keeps the list items", () => {
  assert.equal(
    prepareSpeech("## Answer\n\n- first", { excerpt: false, skipMarkdownSections: false }).includes(
      "first"
    ),
    true
  );
});

test("barStateFor hides the bar when no reading plays", () => {
  assert.deepEqual(barStateFor(null, true), { active: false, paused: false });
});

test("barStateFor shows a paused reading as paused", () => {
  assert.deepEqual(barStateFor("req-1", true), { active: true, paused: true });
});

test("barStateFor shows a playing reading as not paused", () => {
  assert.deepEqual(barStateFor("req-1", false), { active: true, paused: false });
});

test("selection read ignores the skip setting and reads in full", () => {
  assert.equal(speechForRead("selection", markup, { ...ON, skipMarkdownSections: true }), markup);
});

test("excerpt returns whole text when top and bottom overlap", () => {
  const three = "a\n\nb\n\nc";
  assert.equal(excerptSpeech(three, "both", 2, 2), three);
});

test("clamp keeps counts between 1 and 20", () => {
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(99), 20);
  assert.equal(clampCount(7.4), 7);
});

test("toSpeech strips a fenced code block", () => {
  const out = toSpeech("Intro line.\n\n```js\nconst x = 1\n```\n\nOutro line.");
  assert.ok(out.includes("Intro line."));
  assert.ok(out.includes("Outro line."));
  assert.ok(!out.includes("const x"));
  assert.ok(!out.includes("```"));
});

test("toSpeech keeps link labels and drops URLs", () => {
  assert.equal(toSpeech("See [the docs](https://example.com)."), "See the docs.");
});

test("normalizeSettings applies the documented defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), {
    autoRead: false,
    excerpt: true,
    excerptMode: "both",
    excerptTop: 2,
    excerptBottom: 2,
    captions: true,
    glide: false,
    follow: false,
    messageButtons: true,
    selectionRead: true,
    skipMarkdownSections: false
  });
});

test("normalizeSettings keeps a saved skipMarkdownSections value and rejects a non-boolean", () => {
  assert.equal(normalizeSettings({ skipMarkdownSections: true }).skipMarkdownSections, true);
  assert.equal(normalizeSettings({ skipMarkdownSections: "yes" }).skipMarkdownSections, false);
});

test("normalizeSettings keeps a saved follow value and rejects a non-boolean", () => {
  assert.equal(normalizeSettings({ follow: true }).follow, true);
  assert.equal(normalizeSettings({ follow: "yes" }).follow, false);
});

test("normalizeSettings keeps a saved glide value and rejects a non-boolean", () => {
  assert.equal(normalizeSettings({ glide: true }).glide, true);
  assert.equal(normalizeSettings({ glide: "yes" }).glide, false);
});

test("normalizeSettings keeps a saved captions value and rejects a non-boolean", () => {
  assert.equal(normalizeSettings({ captions: false }).captions, false);
  assert.equal(normalizeSettings({ captions: "yes" }).captions, true);
});

test("gate: happy path speaks", () => {
  assert.equal(speakVerdict(happyEvent(), happyState()).speak, true);
});

test("gate: replayed event is skipped", () => {
  assert.equal(speakVerdict(happyEvent({ replayed: true }), happyState()).speak, false);
});

test("gate: unarmed session is skipped", () => {
  assert.equal(speakVerdict(happyEvent(), happyState({ armed: new Set() })).speak, false);
});

test("gate: error status is skipped", () => {
  assert.equal(
    speakVerdict(happyEvent({ payload: { status: "error", text: "boom" } }), happyState()).speak,
    false
  );
});

test("gate: non-focused session is skipped", () => {
  assert.equal(speakVerdict(happyEvent(), happyState({ focusedSessionId: "s2" })).speak, false);
});

test("gate: duplicate claim is skipped", () => {
  const claims = { "claim.s1.5": 1 };
  assert.equal(speakVerdict(happyEvent(), happyState({ claims })).speak, false);
});

test("gate: built-in auto-read on is skipped", () => {
  const verdict = speakVerdict(happyEvent(), happyState({ builtInOn: true }));
  assert.equal(verdict.speak, false);
  assert.equal(verdict.reason, "Hermes built-in auto-read is on");
});

test("gate: autoRead off is skipped", () => {
  assert.equal(
    speakVerdict(happyEvent(), happyState({ settings: { ...ON, autoRead: false } })).speak,
    false
  );
});

test("gate: consumes the armed flag once", () => {
  const state = happyState();
  assert.equal(speakVerdict(happyEvent(), state).speak, true);
  assert.equal(state.armed.has("s1"), false);
});

test("withClaim keeps at most 50 newest claims", () => {
  let claims = {};
  for (let i = 0; i < 60; i += 1) claims = withClaim(claims, "claim.s." + i, i);
  const keys = Object.keys(claims);
  assert.equal(keys.length, 50);
  assert.ok(!("claim.s.0" in claims));
  assert.ok("claim.s.59" in claims);
});

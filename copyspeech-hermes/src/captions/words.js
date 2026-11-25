import { ALIGN_WINDOW, RUN_NEEDED } from "../constants.js";

// Words as letter or digit runs. Each word keeps its character range in the text.
export function wordTokens(text) {
  const tokens = [];
  for (const match of String(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.push({
      norm: match[0].toLowerCase(),
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

// The norms of a speech text, for the code-split merge on selection reads.
export function wordNorms(text) {
  return new Set(wordTokens(text).map((word) => word.norm));
}

// Lowercased letters and digits only, so punctuation and wrapping do not
// split a match between the spoken text and the rendered text.
export function normalizeWord(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// Group CopySpeech caption entries under each spoken word. ElevenLabs sends one
// entry per character; other engines send whole words. Both give one window per word.
export function captionWords(caption) {
  const entries = Array.isArray(caption.words) ? caption.words : [];
  const words = [];
  for (const token of wordTokens(caption.text)) {
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const entry of entries) {
      if (!(entry.text_end > token.start && entry.text_start < token.end)) continue;
      if (entry.end_ms <= entry.start_ms) continue;
      startMs = Math.min(startMs, entry.start_ms);
      endMs = Math.max(endMs, entry.end_ms);
    }
    if (endMs > startMs) words.push({ norm: token.norm, start_ms: startMs, end_ms: endMs });
  }
  return words;
}

export function activeWordIndex(words, position) {
  return words.findIndex((word) => position >= word.start_ms && position < word.end_ms);
}

function findNear(tokens, norm, from) {
  const highest = Math.min(tokens.length, from + ALIGN_WINDOW);
  for (let scan = from; scan < highest; scan += 1) {
    if (tokens[scan].norm === norm) return scan;
  }
  return -1;
}

// True when the next `need` words follow word i in order from token `at`.
function runAt(words, tokens, i, at, need) {
  let cursor = at + 1;
  for (let k = i + 1; k < i + need; k += 1) {
    const found = findNear(tokens, words[k].norm, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

// Find word i far ahead of `from`. A run of words must follow it, so one common word cannot match alone.
// A fragment with fewer words left than RUN_NEEDED needs all of them; a single word never anchors.
function resync(words, tokens, i, from) {
  const need = Math.min(RUN_NEEDED, words.length - i);
  if (need < 2) return -1;
  for (let scan = from; scan < tokens.length; scan += 1) {
    if (tokens[scan].norm === words[i].norm && runAt(words, tokens, i, scan, need)) return scan;
  }
  return -1;
}

// Map each caption word to a rendered token, in order. Reports the counts even on failure.
// The first word of each fragment uses resync, so an excerpt gap cannot pull the anchor onto a common word.
export function alignDetail(words, tokens, from) {
  const map = words.map(() => -1);
  let cursor = from;
  let mapped = 0;
  for (let i = 0; i < words.length; i += 1) {
    let at = mapped === 0 ? -1 : findNear(tokens, words[i].norm, cursor);
    // A near match anchors only when the following words follow it. A common
    // word inside a skipped excerpt gap fails this check, so resync finds the
    // real run. With no later run, keep the near match (TTS may respell a word).
    if (at >= 0 && !runAt(words, tokens, i, at, Math.min(RUN_NEEDED, words.length - i))) {
      const far = resync(words, tokens, i, cursor);
      if (far >= 0) at = far;
    }
    if (at < 0) at = resync(words, tokens, i, cursor);
    if (at < 0) continue;
    map[i] = at;
    cursor = at + 1;
    mapped += 1;
  }
  const ok = mapped > 0 && mapped * 2 >= words.length;
  return { ok: ok, map: map, cursor: cursor, mapped: mapped };
}

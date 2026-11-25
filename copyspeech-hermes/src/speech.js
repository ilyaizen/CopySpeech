import { MAX_CLAIMS } from "./constants.js";
import { clampCount } from "./settings.js";

// Drop whole Markdown lines that speech reads badly: headings, bullet and
// numbered items, horizontal rules, and table rows. The text under a heading
// stays, so an answer under "## Answer" still reads. Runs before toSpeech.
export function dropSkippedMarkup(markdown) {
  const skipped = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|| ?([-*_]) ?(?:\1 ?){2,}$)/;
  return String(markdown ?? "")
    .split("\n")
    .filter((line) => !skipped.test(line))
    .join("\n");
}

// Turn rendered Markdown into plain text for a speech engine.
export function toSpeech(markdown) {
  let text = markdown == null ? "" : String(markdown);
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^ {0,3}#{1,6}\s*/gm, "");
  text = text.replace(/^ {0,3}>\s?/gm, "");
  text = text.replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  text = text.replace(/\|/g, " ");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Keep the first and last paragraphs of a reply. Paragraphs are blank-line blocks.
export function excerptSpeech(text, mode, topCount, bottomCount) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  if (blocks.length < 2) return text;
  const top = clampCount(topCount);
  const bottom = clampCount(bottomCount);
  if (mode === "top") return blocks.slice(0, top).join("\n\n");
  if (mode === "bottom") return blocks.slice(-bottom).join("\n\n");
  if (top + bottom >= blocks.length) return text;
  return blocks.slice(0, top).concat(blocks.slice(-bottom)).join("\n\n");
}

export function prepareSpeech(text, settings) {
  const speech = toSpeech(settings.skipMarkdownSections ? dropSkippedMarkup(text) : text);
  if (!settings.excerpt) return speech;
  return excerptSpeech(speech, settings.excerptMode, settings.excerptTop, settings.excerptBottom);
}

// Message reads and auto-read follow the excerpt settings. A selection is the user's own pick, so it reads in full.
export function speechForRead(source, text, settings) {
  if (source === "selection") return text;
  return prepareSpeech(text, settings);
}

export function claimKey(event) {
  return "claim." + event.session_id + "." + event.seq;
}

// Adds one claim and keeps only the newest MAX_CLAIMS entries.
export function withClaim(claims, key, now) {
  const next = { ...claims, [key]: now };
  const keys = Object.keys(next).sort((a, b) => next[a] - next[b]);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CLAIMS))) delete next[old];
  return next;
}

export const BUILT_IN_REASON = "Hermes built-in auto-read is on";

// Runs the gates in order. Consumes the armed flag when the session passes gate 3.
export function speakVerdict(event, state) {
  const skip = (reason) => ({ speak: false, reason });
  if (!state.settings.autoRead) return skip("auto-read off");
  if (event.replayed === true) return skip("replayed event");
  if (!state.armed.has(event.session_id)) return skip("no message.start for this session");
  state.armed.delete(event.session_id);
  const payload = event.payload || {};
  if (payload.status !== "complete") return skip("status " + payload.status);
  if (event.session_id !== state.focusedSessionId) return skip("session not focused");
  if (!String(payload.text || "").trim()) return skip("empty text");
  if (Object.prototype.hasOwnProperty.call(state.claims, claimKey(event)))
    return skip("duplicate claim");
  if (state.builtInOn) return skip(BUILT_IN_REASON);
  return { speak: true, reason: "ok" };
}

export function readClaims(storage) {
  const raw = storage.get("claims", {});
  return raw ?? {};
}

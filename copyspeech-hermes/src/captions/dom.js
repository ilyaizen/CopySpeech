import { host } from "@hermes/plugin-sdk";
import { normalizeWord, wordTokens } from "./words.js";
import { MESSAGE_BODY_SELECTOR, MESSAGE_ROOT_SELECTOR, REASONING_SELECTOR } from "../constants.js";

// Document lookups for captions and reads: the reply roots, the rendered word
// tokens, and the ranges a token paints.
//
// A token is one word: { node, start, endNode, end, text, norm, code }. `node`
// and `start` mark its first character. `endNode` and `end` mark its last one.
// A word that a syntax highlighter split across text nodes has its own
// `endNode`. `text` holds the word as the node held it, or null for a merged
// token, which has no single slice to check.

const SELECTION_WORD = /\S+/gu;
const SELECTION_WORD_CHAR = /[\p{L}\p{N}]/u;

// The first and last letter or digit of a whitespace-free run.
function wordSpan(raw) {
  let start = 0;
  let end = raw.length;
  while (start < end && !SELECTION_WORD_CHAR.test(raw[start])) start += 1;
  while (end > start && !SELECTION_WORD_CHAR.test(raw[end - 1])) end -= 1;
  return { start: start, end: end };
}

// The words inside one cloned selection range, in document order. Code tokens
// carry a flag, because syntax highlighters split one word across text nodes.
export function tokensFromRange(range, speechNorms) {
  const tokens = [];
  if (range === null) return tokens;
  const root = range.commonAncestorContainer;
  if (root === null || !root.isConnected) return tokens;
  const area = root.nodeType === 3 ? root.parentElement : root;
  if (area === null) return tokens;
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node.nodeValue ?? "";
    const first = node === range.startContainer ? range.startOffset : 0;
    const last = node === range.endContainer ? range.endOffset : text.length;
    if (last <= first) continue;
    const inCode = node.parentElement !== null && node.parentElement.closest("code, pre") !== null;
    const slice = text.slice(first, last);
    for (const match of slice.matchAll(SELECTION_WORD)) {
      const norm = normalizeWord(match[0]);
      if (norm === "") continue;
      const span = wordSpan(match[0]);
      const base = first + match.index;
      tokens.push({
        node: node,
        start: base + span.start,
        endNode: node,
        end: base + span.end,
        text: match[0].slice(span.start, span.end),
        norm: norm,
        code: inCode
      });
    }
  }
  return mergeCodeSplits(tokens, speechNorms);
}

// Syntax highlighters split one code word across several text nodes, so the
// per-node tokens never match the spoken word ("keep" + "_mark" vs "keepmark").
// Merge adjacent code tokens while their concatenated norm exists in the spoken
// stream. The merge can only create a spoken match, never break one.
function mergeCodeSplits(tokens, speechNorms) {
  if (speechNorms === undefined || speechNorms === null || speechNorms.size === 0) {
    return tokens;
  }
  const out = [];
  let index = 0;
  while (index < tokens.length) {
    const first = tokens[index];
    if (first.code !== true) {
      out.push(first);
      index += 1;
      continue;
    }
    let merged = first;
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      if (next.code !== true) break;
      const joined = merged.norm + next.norm;
      if (!speechNorms.has(joined)) break;
      merged = {
        node: first.node,
        start: first.start,
        endNode: next.endNode,
        end: next.end,
        text: null,
        norm: joined,
        code: true
      };
      cursor += 1;
    }
    out.push(merged);
    index = cursor;
  }
  return out;
}

// The chat pane the user works in. Hermes marks each chat pane with data-session-anchor:
// `session-tile:<storedId>` for a tile, `workspace` for the primary. A focused tile has
// focusedStoredSessionId = its storedId; otherwise that id is the primary's selection.
// With no anchors at all (an older Hermes), the whole document is the scope.
// Null when anchors exist but none matches, so no caption paints in the wrong chat.
function focusedPane() {
  if (document.querySelectorAll("[data-session-anchor]").length === 0) return document;
  const stored = host.state.focusedStoredSessionId?.get?.() ?? null;
  const tile = stored ? document.querySelector(anchorSelector("session-tile:" + stored)) : null;
  return tile ?? document.querySelector(anchorSelector("workspace")) ?? null;
}

function anchorSelector(anchor) {
  return '[data-session-anchor="' + String(anchor).replace(/["\\]/g, "\\$&") + '"]';
}

// The session the chat shows. Hosts without focusedSessionId fall back to activeSessionId.
export function focusedSession() {
  const atom =
    host.state.focusedSessionId !== undefined
      ? host.state.focusedSessionId
      : host.state.activeSessionId;
  return atom.get();
}

// The newest `count` assistant replies in the focused pane, oldest first.
export function recentReplyRoots(count) {
  const scope = focusedPane();
  if (scope === null) return [];
  const roots = Array.from(scope.querySelectorAll(MESSAGE_ROOT_SELECTOR));
  return roots.slice(Math.max(0, roots.length - count));
}

// Text tokens of a reply root, minus reasoning and, when asked, code blocks.
// Words keep their node and range. Code blocks are skipped for the same reason
// the spoken text skips them: CopySpeech never reads them, so a code word must
// not pull the highlight.
export function rootTokens(root, skipCode) {
  const tokens = [];
  if (root === undefined || root === null) return tokens;
  for (const body of root.querySelectorAll(MESSAGE_BODY_SELECTOR)) {
    if (body.closest(REASONING_SELECTOR) !== null) continue;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (skipCode && node.parentElement !== null && node.parentElement.closest("pre") !== null) {
        continue;
      }
      for (const token of wordTokens(node.nodeValue ?? "")) tokens.push({ ...token, node: node });
    }
  }
  return tokens;
}

export function tokenRange(token) {
  const range = document.createRange();
  range.setStart(token.node, token.start);
  range.setEnd(token.endNode ?? token.node, token.end);
  return range;
}

function fitsNode(node, offset) {
  const value = node.nodeValue;
  return value !== null && value !== undefined && offset >= 0 && offset <= value.length;
}

// True while the token still points at its words. Markdown re-renders can change
// a text node in place, and a range over stale offsets throws. A caller that
// sees false must drop its alignment and align again.
export function tokenLive(token) {
  const endNode = token.endNode ?? token.node;
  if (!token.node.isConnected || !endNode.isConnected) return false;
  if (!fitsNode(token.node, token.start) || !fitsNode(endNode, token.end)) return false;
  if (token.text === null || token.text === undefined) return true;
  return token.node.nodeValue.slice(token.start, token.end) === token.text;
}

export function liveStyle(el) {
  return window.getComputedStyle(el);
}

// Scroll behaviour for the reply: smooth, or an instant jump when the OS asks for reduced motion.
// "instant" overrides the page's CSS scroll-behavior; "auto" would keep a page's smooth default.
export function motionBehavior() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}

// The nearest ancestor that scrolls its content vertically, or null.
export function findScroller(element) {
  let node = element.parentElement;
  while (node !== null) {
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

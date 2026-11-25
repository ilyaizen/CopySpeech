import { findScroller, motionBehavior, tokenRange } from "./dom.js";
import { firstPaintedRect } from "./geometry.js";
import {
  FOLLOW_ANCHOR,
  FOLLOW_BAND_BOTTOM,
  FOLLOW_BAND_TOP,
  FOLLOW_INTERVAL_MS
} from "../constants.js";

// Listen for manual input on the run's scroller. A wheel, a scroll key, any touch inside it
// (a tap on a word too, since a touch can start a scroll), or a press on the scroller's own
// box (its scrollbar or background that no child covers) pauses follow. A mouse press on a
// word does not.
function watchScroller(run, scroller) {
  if (run.watched === scroller) return;
  unwatchScroller(run);
  run.watched = scroller;
  scroller.addEventListener("wheel", run.pause, { passive: true });
  scroller.addEventListener("touchstart", run.pause, { passive: true });
  scroller.addEventListener("keydown", run.pauseKey, true);
  scroller.addEventListener("pointerdown", run.pauseScrollbar, { passive: true });
}

export function unwatchScroller(run) {
  const scroller = run.watched;
  if (scroller === null) return;
  scroller.removeEventListener("wheel", run.pause);
  scroller.removeEventListener("touchstart", run.pause);
  scroller.removeEventListener("keydown", run.pauseKey, true);
  scroller.removeEventListener("pointerdown", run.pauseScrollbar);
  run.watched = null;
}

// The scroller that holds the word. Keeps the current one while the word stays inside it.
function ensureScroller(run, token) {
  const current = run.scroller;
  if (current !== null && current.isConnected && current.contains(token.node)) {
    // Re-attach on reuse too. watchScroller is a no-op when the listeners are already attached.
    watchScroller(run, current);
    return current;
  }
  const element = token.node.parentElement;
  run.scroller = element === null ? null : findScroller(element);
  if (run.scroller === null) unwatchScroller(run);
  else watchScroller(run, run.scroller);
  return run.scroller;
}

// True while a text selection in the reply starts or ends inside the scroller. Follow then
// leaves the view alone, so a reader's drag-select is not fought.
function selectingIn(scroller) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  return [selection.anchorNode, selection.focusNode].some(
    (node) => node !== null && node !== undefined && scroller.contains(node)
  );
}

// Scroll only when the spoken word leaves the comfort band, so most words move nothing.
export function followToken(run, token) {
  if (!run.follow) return;
  const now = Date.now();
  if (now < run.followPausedUntil || now - run.lastScrollAt < FOLLOW_INTERVAL_MS) return;
  const scroller = ensureScroller(run, token);
  if (scroller === null || selectingIn(scroller)) return;
  const rect = firstPaintedRect(tokenRange(token));
  if (rect === undefined) return;
  const box = scroller.getBoundingClientRect();
  const top = rect.top - box.top;
  const bottom = top + rect.height;
  if (top >= box.height * FOLLOW_BAND_TOP && bottom <= box.height * FOLLOW_BAND_BOTTOM) return;
  run.lastScrollAt = now;
  const offset = top - box.height * FOLLOW_ANCHOR;
  scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: motionBehavior() });
}

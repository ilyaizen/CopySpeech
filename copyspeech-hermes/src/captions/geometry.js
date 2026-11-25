import { CLIP_OVERFLOW, PILL_PAD_X, PILL_PAD_Y } from "../constants.js";

// Linear blend of two rects. `p` runs from 0 (at `a`) to 1 (at `b`).
export function lerpRect(a, b, p) {
  return {
    left: a.left + (b.left - a.left) * p,
    top: a.top + (b.top - a.top) * p,
    width: a.width + (b.width - a.width) * p,
    height: a.height + (b.height - a.height) * p
  };
}

// CSS cubic-bezier(x1, y1, x2, y2) as an easing function over [0, 1].
function cubicBezier(x1, y1, x2, y2) {
  const axis = function (a1, a2, t) {
    return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
  };
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0;
    let high = 1;
    let t = x;
    for (let i = 0; i < 20; i += 1) {
      t = (low + high) / 2;
      if (axis(x1, x2, t) < x) low = t;
      else high = t;
    }
    return axis(y1, y2, t);
  };
}

// Swift start, then settle. The same curve as the DSH pill.
export const easeGlide = cubicBezier(0, 0.5, 0, 1);

// Overflow clips a box's content, but an inline box does not clip, so it is skipped.
function clipsContent(style) {
  if (style.display === "inline") return false;
  return CLIP_OVERFLOW.includes(style.overflowX) || CLIP_OVERFLOW.includes(style.overflowY);
}

// The area an element's overflow clips to: its padding box, without scrollbars.
function paddingBox(el) {
  const box = el.getBoundingClientRect();
  const left = box.left + el.clientLeft;
  const top = box.top + el.clientTop;
  return { left: left, top: top, right: left + el.clientWidth, bottom: top + el.clientHeight };
}

// The overlap of two boxes. Null when they do not overlap.
function overlapBox(a, b) {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom)
  };
  if (box.right <= box.left || box.bottom <= box.top) return null;
  return box;
}

// The viewport cut by every ancestor whose overflow clips `node`. Null when nothing is left.
export function clipBox(node, styleOf, viewport) {
  let box = viewport;
  for (let el = node.parentElement; el !== null && box !== null; el = el.parentElement) {
    if (clipsContent(styleOf(el))) box = overlapBox(box, paddingBox(el));
  }
  return box;
}

// Cut a {left, top, width, height} rect to a clip box. Null when nothing is left.
export function cutRect(rect, clip) {
  if (clip === null) return null;
  const left = Math.max(rect.left, clip.left);
  const top = Math.max(rect.top, clip.top);
  const right = Math.min(rect.left + rect.width, clip.right);
  const bottom = Math.min(rect.top + rect.height, clip.bottom);
  if (right <= left || bottom <= top) return null;
  return { left: left, top: top, width: right - left, height: bottom - top };
}

// The first client rect of a range that has a size. Undefined when none does.
export function firstPaintedRect(range) {
  let rects = [];
  try {
    rects = Array.from(range.getClientRects());
  } catch {
    rects = [];
  }
  return rects.find(function (r) {
    return r.width > 0 && r.height > 0;
  });
}

// The padded box of a word's first painted client rect, cut to every clipping ancestor
// and the viewport. Returns null when no part of the word is visible.
export function measureWord(range, styleOf, viewport) {
  const rect = firstPaintedRect(range);
  if (rect === undefined) return null;
  const padded = {
    left: rect.left - PILL_PAD_X,
    top: rect.top - PILL_PAD_Y,
    width: rect.width + 2 * PILL_PAD_X,
    height: rect.height + 2 * PILL_PAD_Y
  };
  return cutRect(padded, clipBox(range.startContainer, styleOf, viewport));
}

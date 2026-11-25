import { liveStyle } from "./dom.js";
import { clipBox, cutRect, easeGlide, lerpRect, measureWord } from "./geometry.js";
import { GLIDE_FRAME_CAP_MS, GLIDE_MS, PILL_RADIUS_PX, PILL_Z_INDEX } from "../constants.js";

// The one glide pill on the page. Created on first use, destroyed with the run.
let pill = null;

// The visible area, in viewport coordinates.
function liveViewport() {
  const root = document.documentElement;
  return { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
}

// Browser hooks for the glide pill. The pill itself touches no globals.
export function livePillEnv() {
  return {
    make: function () {
      return document.createElement("div");
    },
    attach: function (el) {
      document.documentElement.appendChild(el);
    },
    measure: function (range) {
      return measureWord(range, liveStyle, liveViewport());
    },
    clip: function (range) {
      return clipBox(range.startContainer, liveStyle, liveViewport());
    },
    reduced: function () {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
    raf: function (fn) {
      return window.requestAnimationFrame(fn);
    },
    cancelRaf: function (id) {
      window.cancelAnimationFrame(id);
    },
    listen: function (type, fn) {
      window.addEventListener(type, fn, { capture: true, passive: true });
      return function () {
        window.removeEventListener(type, fn, true);
      };
    }
  };
}

export function ensurePill() {
  if (pill === null) pill = createGlidePill(livePillEnv());
  return pill;
}

export function destroyPill() {
  if (pill === null) return;
  pill.destroy();
  pill = null;
}

// The glide pill: one fixed div over the spoken word, moved by one rAF loop.
// The loop runs only while the pill moves. It re-reads the word's rect on every frame,
// so scroll and layout changes during a glide land on the word.
// `env` supplies the browser hooks: make, attach, measure, reduced, raf, cancelRaf, listen.
export function createGlidePill(env) {
  let el = null;
  let range = null;
  let drawn = null;
  let from = null;
  let frame = 0;
  let elapsed = 0;
  let last = null;
  let offs = [];

  function target() {
    return range === null ? null : env.measure(range);
  }

  function draw(rect) {
    drawn = rect;
    if (el === null) return;
    if (rect === null) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
  }

  function stopLoop() {
    if (frame !== 0) env.cancelRaf(frame);
    frame = 0;
  }

  function tick(ts) {
    frame = 0;
    if (el === null || range === null || !range.startContainer.isConnected) {
      destroy();
      return;
    }
    const next = target();
    if (next === null) {
      from = null;
      draw(null);
      return;
    }
    // Cap each frame's step, so a late frame does not skip ahead.
    const step = last === null ? 0 : Math.min(ts - last, GLIDE_FRAME_CAP_MS);
    last = ts;
    elapsed = Math.min(elapsed + step, GLIDE_MS);
    // Bound each intermediate frame to the target's clip. Start and target can sit in different clips.
    draw(cutRect(lerpRect(from, next, easeGlide(elapsed / GLIDE_MS)), env.clip(range)));
    if (elapsed < GLIDE_MS) {
      frame = env.raf(tick);
    } else {
      from = null;
      last = null;
    }
  }

  // Move the pill to a word. A glide starts from the drawn place, so a new word mid-glide
  // continues from where the pill is, not from where the last glide began.
  function move(next) {
    range = next;
    if (el === null) create();
    stopLoop();
    last = null;
    elapsed = 0;
    const rect = target();
    if (rect === null) {
      from = null;
      draw(null);
      return;
    }
    if (drawn === null || env.reduced()) {
      from = null;
      draw(rect);
      return;
    }
    from = drawn;
    frame = env.raf(tick);
  }

  // Re-place the pill on the word. A running glide already reads the live rect each frame.
  function reposition() {
    if (el === null) return;
    if (range !== null && !range.startContainer.isConnected) {
      destroy();
      return;
    }
    if (frame !== 0) return;
    draw(target());
  }

  function create() {
    el = env.make();
    el.setAttribute("aria-hidden", "true");
    el.style.position = "fixed";
    el.style.zIndex = String(PILL_Z_INDEX);
    el.style.pointerEvents = "none";
    el.style.borderRadius = PILL_RADIUS_PX + "px";
    el.style.background = "#fff";
    el.style.mixBlendMode = "difference";
    env.attach(el);
    offs = [env.listen("scroll", reposition), env.listen("resize", reposition)];
  }

  function destroy() {
    stopLoop();
    for (const off of offs) off();
    offs = [];
    if (el !== null) el.remove();
    el = null;
    range = null;
    drawn = null;
    from = null;
    last = null;
    elapsed = 0;
  }

  return {
    move: move,
    reposition: reposition,
    destroy: destroy,
    moving: function () {
      return frame !== 0;
    },
    element: function () {
      return el;
    }
  };
}

// The live pill, or null. Tests read it through testing.js.
export function currentPill() {
  return pill;
}

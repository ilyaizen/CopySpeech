// Shared fixtures for the Node tests. plugin.test.mjs imports every test file, and each
// test file imports the fixtures it uses from here.
//
// The tests load test/under-test.mjs, the bundle of src/. Its SDK imports point at
// the stubs in test/stubs/. Before loading, the harness checks that the bundle is current.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const check = spawnSync("bun", [join(repo, "copyspeech-hermes", "build.mjs"), "--check"], {
  cwd: repo,
  encoding: "utf8"
});
if (check.status !== 0) {
  throw new Error("plugin bundle check failed:\n" + check.stdout + check.stderr);
}

const stubs = join(here, "stubs");
const SPECIFIERS = {
  "@hermes/plugin-sdk": pathToFileURL(join(stubs, "sdk.mjs")).href,
  "react/jsx-runtime": pathToFileURL(join(stubs, "jsx-runtime.mjs")).href,
  react: pathToFileURL(join(stubs, "react.mjs")).href
};

async function loadBundle() {
  const source = readFileSync(join(here, "under-test.mjs"), "utf8").replace(
    /from "(@hermes\/plugin-sdk|react\/jsx-runtime|react)";/g,
    (_match, name) => 'from "' + SPECIFIERS[name] + '";'
  );
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "copyspeech-hermes-test-"));
  const copy = join(scratch, "under-test.mjs");
  writeFileSync(copy, source);
  try {
    return await import(pathToFileURL(copy).href);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const mod = await loadBundle();
export const plugin = mod.default;
export const cases = [];
export function test(name, fn) {
  cases.push({ name, fn });
}
export const {
  toSpeech,
  excerptSpeech,
  prepareSpeech,
  speechForRead,
  dropSkippedMarkup,
  barStateFor,
  speakVerdict,
  withClaim,
  normalizeSettings,
  clampCount,
  wordTokens,
  captionWords,
  activeWordIndex,
  alignDetail,
  pendingEdits,
  draftView,
  applyEdit,
  createGlidePill,
  measureWord,
  pollPlan,
  startRun,
  stopCaptions,
  livePillEnv,
  liveCaptionRun,
  livePill,
  playbackRequestIdNow,
  clearPlayback,
  makeMessageButton,
  selectionInsideReply,
  playbackRemember,
  stopReadingNow,
  hooks,
  BUILT_IN_REASON
} = mod;
export const { tokensFromRange, tokenRange, tokenLive } = mod;

export const ON = {
  autoRead: true,
  excerpt: true,
  excerptMode: "both",
  excerptTop: 2,
  excerptBottom: 2
};

export function happyState(overrides = {}) {
  return {
    settings: ON,
    focusedSessionId: "s1",
    armed: new Set(["s1"]),
    claims: {},
    builtInOn: false,
    ...overrides
  };
}

export function happyEvent(overrides = {}) {
  return {
    type: "message.complete",
    session_id: "s1",
    seq: 5,
    replayed: false,
    payload: { status: "complete", text: "Hello there." },
    ...overrides
  };
}

export const para = ["a", "b", "c", "d"].join("\n\n");

export const markup =
  "## Answer\n\nIntro line.\n\n- first\n- second\n\n1. one\n\n---\n\n| a | b |\n\nClosing.";

// Caption helpers. Entries use the /status shape: character ranges in caption.text.
export function wordEntries(text, spans) {
  return spans.map(([start, end, startMs, endMs]) => ({
    text_start: start,
    text_end: end,
    start_ms: startMs,
    end_ms: endMs
  }));
}
export function captionOf(text, entries) {
  return { text, words: entries };
}
export const norms = (tokens) => tokens.map((token) => token.norm);

export const SAVED = {
  autoRead: false,
  excerpt: true,
  excerptMode: "both",
  excerptTop: 2,
  excerptBottom: 2,
  captions: true
};

// Glide pill. The harness fakes rAF, the element and the word rects: a test moves a
// word by changing its rect, the way a scroll or a re-layout does.
export function box(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}
export function wordAt(left, top, width, height) {
  return { startContainer: { isConnected: true }, rect: box(left, top, width, height) };
}
export function pillHarness(reduced = false) {
  let nextId = 1;
  let frames = [];
  let motion = reduced;
  const attached = new Set();
  const listeners = new Set();
  const env = {
    make() {
      return {
        style: {},
        setAttribute() {},
        remove() {
          attached.delete(this);
        }
      };
    },
    attach(el) {
      attached.add(el);
    },
    measure(range) {
      return range.rect === null ? null : { ...range.rect };
    },
    clip() {
      return UNBOUNDED;
    },
    reduced() {
      return motion;
    },
    raf(fn) {
      const id = nextId;
      nextId += 1;
      frames.push({ id, fn });
      return id;
    },
    cancelRaf(id) {
      frames = frames.filter((frame) => frame.id !== id);
    },
    listen(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    }
  };
  return {
    env,
    attached,
    listeners,
    pending: () => frames.length,
    step(ts) {
      const due = frames;
      frames = [];
      for (const frame of due) frame.fn(ts);
    }
  };
}
export function finishGlide(harness, start) {
  let at = start;
  for (let guard = 0; harness.pending() > 0; guard += 1) {
    assert.ok(guard < 100, "glide must end");
    harness.step(at);
    at += 16;
  }
  return at;
}
export const leftOf = (pill) => parseFloat(pill.element().style.left);

// measureWord: the padded rect, cut to every clipping ancestor and the viewport.
export const plainStyle = () => ({ overflowX: "visible", overflowY: "visible", display: "block" });
export const scrollStyle = (el) => ({
  overflowX: el.overflow,
  overflowY: el.overflow,
  display: "block"
});
export const VIEW = box(0, 0, 1000, 1000);
// A clipping ancestor. In this fake the padding box equals the border box.
export function clipper(overflow, rect, parent = null) {
  return {
    parentElement: parent,
    overflow: overflow,
    getBoundingClientRect: () => rect,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: rect.width,
    clientHeight: rect.height
  };
}

// pollPlan: what a caption poll does when settings or focus change.
export const runOf = { sessionId: "s1", mode: "plain" };

// Production paint and status wiring. A small fake browser stands in for the DOM: text laid out at
// 8 px per character, 16 px tall, at its parent's top-left plus `x`. Tests move boxes to simulate
// a scroll or a re-layout, the way the glide harness above does.
export const UNBOUNDED = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
export const CHAR_W = 8;
export const CHAR_H = 16;
export const REPLY = "Hello there friend";
export const REPLY_RECT = { left: 100, top: 100, width: 400, height: 20 };
export const REPLY_WORDS = wordEntries(REPLY, [
  [0, 5, 0, 400],
  [6, 11, 450, 900],
  [12, 18, 950, 1400]
]);
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
export const bodyAt = (position) => ({
  active: true,
  position_ms: position,
  fragment_index: 0,
  captions: captionOf(REPLY, REPLY_WORDS)
});
export const pillStyle = () => livePill().element().style;

export function fakeEl(rect) {
  return {
    rect: rect,
    parentElement: null,
    overflowX: "visible",
    overflowY: "visible",
    display: "block",
    clientLeft: 0,
    clientTop: 0,
    clientWidth: rect.width,
    clientHeight: rect.height,
    style: {},
    isConnected: true,
    texts: [],
    getBoundingClientRect() {
      const r = this.rect;
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.left + r.width,
        bottom: r.top + r.height
      };
    },
    appendChild(child) {
      child.parentElement = this;
      return child;
    },
    closest() {
      return null;
    },
    handlers: [],
    scrollTop: 0,
    contains(node) {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (el === this) return true;
      }
      return false;
    },
    addEventListener(type, fn, options) {
      this.handlers.push({ type: type, fn: fn, capture: options === true });
    },
    removeEventListener(type, fn) {
      this.handlers = this.handlers.filter((h) => h.type !== type || h.fn !== fn);
    },
    dispatch(type, event) {
      for (const h of this.handlers.filter((x) => x.type === type)) h.fn(event);
    },
    setAttribute() {},
    remove() {
      this.isConnected = false;
    }
  };
}

// The DOM throws IndexSizeError for an offset past a text node's end. The fake must too,
// or a range over stale offsets passes here and fails only in Hermes.
function assertInNode(node, offset) {
  const length = node.nodeValue?.length;
  if (length !== undefined && (offset < 0 || offset > length)) {
    throw new RangeError("IndexSizeError: offset " + offset + " past a node of length " + length);
  }
}

export function fakeRange() {
  return {
    startContainer: null,
    start: 0,
    end: 0,
    setStart(node, offset) {
      assertInNode(node, offset);
      this.startContainer = node;
      this.start = offset;
    },
    setEnd(node, offset) {
      assertInNode(node, offset);
      this.end = offset;
    },
    getClientRects() {
      const node = this.startContainer;
      const origin = node.parentElement.rect;
      const left = origin.left + node.x + this.start * CHAR_W;
      return [
        {
          left: left,
          top: origin.top + (node.y ?? 0),
          width: (this.end - this.start) * CHAR_W,
          height: CHAR_H
        }
      ];
    }
  };
}

export function rangeOver(node, start, end) {
  const range = fakeRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

export let installedWorld = false;
// Installs fake window, document, host and fetch, then stops the last test's run.
export function freshWorld() {
  if (installedWorld) stopCaptions(); // while the last test's fakes still exist
  installedWorld = true;
  const html = fakeEl({ left: 0, top: 0, width: 1000, height: 800 });
  const body = html.appendChild(fakeEl({ left: 0, top: 0, width: 1000, height: 800 }));
  const replies = [];
  const world = {
    body: body,
    replies: replies,
    highlights: new Map(),
    frames: [],
    listeners: [],
    rafCount: 0,
    calls: [],
    timers: [],
    focus: { current: "s1" },
    settings: { captions: true, glide: false, follow: false },
    fetchUrls: []
  };
  let nextId = 1;
  globalThis.window = {
    CSS: { highlights: world.highlights },
    Highlight: class Highlight {
      constructor(range) {
        this.range = range;
      }
    },
    getComputedStyle: (el) => ({
      overflowX: el.overflowX,
      overflowY: el.overflowY,
      display: el.display
    }),
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(fn) {
      world.rafCount += 1;
      const id = nextId;
      nextId += 1;
      world.frames.push({ id: id, fn: fn });
      return id;
    },
    cancelAnimationFrame(id) {
      world.frames = world.frames.filter((frame) => frame.id !== id);
    },
    addEventListener(type, fn) {
      world.listeners.push({ type: type, fn: fn });
    },
    removeEventListener(type, fn) {
      world.listeners = world.listeners.filter((l) => l.type !== type || l.fn !== fn);
    }
  };
  const root = { querySelectorAll: () => replies, isConnected: true };
  world.roots = [root];
  globalThis.document = {
    documentElement: html,
    head: fakeEl({ left: 0, top: 0, width: 0, height: 0 }),
    getElementById: () => null,
    createElement: () => fakeEl({ left: 0, top: 0, width: 0, height: 0 }),
    createRange: fakeRange,
    createTreeWalker(scope) {
      const queue = scope.texts.slice();
      return { nextNode: () => (queue.length > 0 ? queue.shift() : null) };
    },
    querySelectorAll: (selector) => (selector.includes("assistant-message-root") ? world.roots : [])
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.host = {
    state: { focusedSessionId: { get: () => world.focus.current } },
    notify() {}
  };
  // Speech requests resolve at once. Each status request waits until the test answers it.
  globalThis.fetch = (url) => {
    world.fetchUrls.push(fetchUrlText(url));
    if (fetchUrlText(url) === SPEAK_URL) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      world.calls.push({
        resolve: (answer) => resolve({ ok: true, json: () => Promise.resolve(answer) })
      });
    });
  };
  world.ctx = {
    setInterval(fn) {
      const timer = { fn: fn, disposed: false };
      world.timers.push(timer);
      return () => {
        timer.disposed = true;
      };
    }
  };
  world.addReply = (rect, text) => {
    const md = body.appendChild(fakeEl({ ...rect }));
    md.texts = [{ nodeValue: text, parentElement: md, isConnected: true, x: 0 }];
    replies.push(md);
    return md;
  };
  world.startRun = (sessionId = world.focus.current) => {
    startRun(world.ctx, () => world.settings, sessionId, null, null);
    return liveCaptionRun();
  };
  // Fires the newest interval, or the one at `index`. A disposed timer still fires, to test the guard.
  world.poll = (index = world.timers.length - 1) => world.timers[index].fn();
  // One poll, then answer its request with `answer`.
  world.tick = async (answer) => {
    const before = world.calls.length;
    world.poll();
    assert.equal(world.calls.length, before + 1, "one status request per poll");
    world.calls[before].resolve(answer);
    await flush();
  };
  world.stepOnce = (ts) => {
    const due = world.frames;
    world.frames = [];
    for (const frame of due) frame.fn(ts);
  };
  world.stepFrames = (ts) => {
    let at = ts;
    for (let guard = 0; world.frames.length > 0; guard += 1) {
      assert.ok(guard < 200, "glide must end");
      world.stepOnce(at);
      at += 16;
    }
    return at;
  };
  world.dispatch = (type) => {
    for (const listener of world.listeners.filter((l) => l.type === type)) {
      listener.fn({ type: type });
    }
  };
  return world;
}

// Follow: captions on and off, manual input, and cleanup. A fake clock drives the pause and interval timers.
export const SPEAK_URL = "http://127.0.0.1:43117/speak";
// fetch accepts a string, a URL, or a Request. Normalize to the absolute URL text.
export function fetchUrlText(input) {
  return input instanceof Request ? input.url : new URL(input).href;
}
export const clock = { now: 1000000 };
export function useFakeClock() {
  clock.now = 1000000;
  Date.now = () => clock.now;
}
export const LINE_ONE = "Alpha beta gamma";
export const LINE_TWO = "Delta epsilon zeta";
export const FOLLOW_TEXT = LINE_ONE + " " + LINE_TWO;
export const FOLLOW_WORDS = wordEntries(FOLLOW_TEXT, [
  [0, 5, 0, 400],
  [6, 10, 450, 900],
  [11, 16, 950, 1400],
  [17, 22, 1500, 1900],
  [23, 30, 1950, 2400],
  [31, 35, 2450, 2900]
]);
export const followBody = (position) => ({
  active: true,
  position_ms: position,
  fragment_index: 0,
  captions: captionOf(FOLLOW_TEXT, FOLLOW_WORDS)
});

// A reply in a scrolling box. Its second line starts below the comfort band (y 350 of 400).
export function addScrolledReply(world) {
  const scroller = world.body.appendChild(fakeEl({ left: 0, top: 0, width: 1000, height: 400 }));
  scroller.overflowY = "auto";
  scroller.scrollHeight = 2000;
  scroller.scrollTop = 0;
  scroller.scrollLog = [];
  const md = scroller.appendChild(fakeEl({ left: 0, top: 0, width: 1000, height: 2000 }));
  md.texts = [
    { nodeValue: LINE_ONE, parentElement: md, isConnected: true, x: 0, y: 100 },
    { nodeValue: LINE_TWO, parentElement: md, isConnected: true, x: 0, y: 350 }
  ];
  world.replies.push(md);
  // A fake scroll moves the reply's layout, the way a real scroll moves its words.
  scroller.scrollTo = function (options) {
    const delta = options.top - this.scrollTop;
    this.scrollTop = options.top;
    md.rect = { ...md.rect, top: md.rect.top - delta };
    this.scrollLog.push(options);
  };
  return { scroller, md };
}

// Move the reply's layout, the way a re-render or an outside scroll would.
export function relayout(md, top) {
  md.rect = { ...md.rect, top: top };
}

// Wire the plugin's own register(ctx) with a fake SDK context, so the message.complete path runs.
export function wireRegister(world, saved) {
  const data = new Map(saved ? [["settings", saved]] : []);
  const storage = {
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => {
      data.set(key, value);
    }
  };
  const handlers = {};
  const ctx = {
    storage: storage,
    onEvent: (type, fn) => {
      handlers[type] = fn;
    },
    onDispose: () => {},
    addEventListener: () => {},
    setInterval: world.ctx.setInterval,
    register: () => {},
    registerSettingsPage: () => {}
  };
  plugin.register(ctx);
  return handlers;
}

export function announceReply(handlers, text) {
  handlers["message.start"]({ session_id: "s1" });
  handlers["message.complete"]({
    type: "message.complete",
    session_id: "s1",
    seq: 9,
    replayed: false,
    payload: { status: "complete", text: text }
  });
}

import {
  focusedSession,
  recentReplyRoots,
  rootTokens,
  tokenLive,
  tokenRange,
  tokensFromRange
} from "./dom.js";
import { followToken, unwatchScroller } from "./follow.js";
import { destroyPill, ensurePill } from "./glide-pill.js";
import { activeWordIndex, alignDetail, captionWords } from "./words.js";
import {
  CAPTION_NAME,
  CAPTION_POLL_MS,
  CAPTION_SILENCE_MS,
  FOLLOW_KEYS,
  FOLLOW_PAUSE_MS,
  PAUSE_RECONCILE_MS,
  STATUS_URL
} from "../constants.js";
import { forgetPlayback, setPlaybackPaused } from "../playback.js";
import { playback } from "../state.js";

// Caption runs. One status poll paints the spoken word inside a reply, moves the
// glide pill, and follows the word with scroll. A run belongs to one reading.
//
// Alignment rules that keep captions on their reply:
// - A message or selection read paints inside the target it was started for.
// - An auto read pins the reply whose text matched first. A newer reply that
//   starts streaming while the old one still plays cannot take the highlight.
// - A token whose text changed under the run is dropped and aligned again. Its
//   range is never built from stale offsets.
// - A paint error drops the alignment and the next poll starts over. The poll
//   never throws out of its timer.

let activeRun = null;

// The run that paints now, or null.
export function currentRun() {
  return activeRun;
}

function captionsSupported() {
  return (
    window.CSS !== undefined &&
    window.CSS.highlights !== undefined &&
    window.Highlight !== undefined
  );
}

function clearCaptionPaint() {
  if (captionsSupported()) window.CSS.highlights.delete(CAPTION_NAME);
}

export function stopCaptions() {
  if (activeRun !== null) {
    const run = activeRun;
    activeRun = null;
    run.dispose();
  }
  destroyPill();
  clearCaptionPaint();
}

// Stop the run only while it is still the live one, so a stale run cannot stop its replacement.
function endRun(run) {
  if (activeRun === run) stopCaptions();
}

// Paint mode of a run: none with captions off, glide with the pill, else the
// CSS highlight. A selection read paints even with the captions switch off.
function paintMode(run, settings) {
  if (!settings.captions && run.forceCaptions !== true) return "none";
  return settings.glide ? "glide" : "plain";
}

// What one status poll does: stop the run, switch paint mode, keep going, or keep
// only the bar. A run with follow on keeps polling while captions are off. A
// controlled run (any plugin-started reading) also keeps polling with every paint
// switch off, because the same poll drives the bar's pause state and retires the
// bar at the end. When focus moves to another chat, a run that owns the playback
// record drops to "bar": no paint, no follow, the poll keeps running. Any other
// run stops.
export function pollPlan(run, settings, focusedId, owned = false) {
  if (run.sessionId !== focusedId) return owned ? "bar" : "stop";
  if (
    !settings.captions &&
    !settings.follow &&
    run.forceCaptions !== true &&
    run.controlled !== true
  ) {
    return "stop";
  }
  return paintMode(run, settings) === run.mode ? "keep" : "switch";
}

// True when the playback record still belongs to this run's reading.
function ownsPlayback(run) {
  return run.requestId !== null && playback.requestId === run.requestId;
}

// Stop painting and following, and keep polling. The bar still needs the poll to retire.
function dimRun(run) {
  run.follow = false;
  unwatchScroller(run);
  run.scroller = null;
  if (run.mode !== "none") switchMode(run, "none");
}

// Re-check focus and settings for a run. Applies a paint-mode change and the follow flag.
// False when the run must stop.
function syncRun(run) {
  const current = run.settings();
  const plan = pollPlan(run, current, focusedSession(), ownsPlayback(run));
  if (plan === "stop") return false;
  if (plan === "bar") {
    dimRun(run);
    return true;
  }
  run.follow = current.follow;
  // Drop the cached scroller with its listeners, so a re-enable looks it up and watches it again.
  if (!run.follow) {
    unwatchScroller(run);
    run.scroller = null;
  }
  if (plan === "switch") switchMode(run, paintMode(run, current));
  return true;
}

// Paint one word. Plain mode uses the CSS highlight. Glide mode moves the pill,
// and only when the word changes, so repeated status ticks do not restart the glide.
function paintToken(run, token) {
  if (run.mode === "none") return;
  if (run.mode !== "glide") {
    destroyPill();
    if (captionsSupported()) {
      window.CSS.highlights.set(CAPTION_NAME, new window.Highlight(tokenRange(token)));
    }
    return;
  }
  clearCaptionPaint();
  if (token === run.pillToken) return;
  run.pillToken = token;
  ensurePill().move(tokenRange(token));
}

// Change the paint mode between two words. The last word repaints in the new mode.
function switchMode(run, mode) {
  run.mode = mode;
  run.pillToken = null;
  destroyPill();
  clearCaptionPaint();
  if (run.lastToken !== null && tokenLive(run.lastToken)) paintToken(run, run.lastToken);
}

// How far an auto read looks back for the reply that carries its words.
const AUTO_CANDIDATES = 4;

// Align the words from `from`. Null when they do not align there.
function tryAlign(words, tokens, from) {
  const detail = alignDetail(words, tokens, from);
  return detail.ok ? { tokens: tokens, detail: detail } : null;
}

// Align from the run's cursor, then from the start of the tokens. A fragment can
// start before the cursor when a reading restarts its text.
function alignTokens(run, words, tokens) {
  return tryAlign(words, tokens, run.cursor) ?? tryAlign(words, tokens, 0);
}

// The tokens that carry these words, or null when no reply carries them yet.
// A message or selection read has one fixed target. An auto read keeps the reply
// it pinned, and pins a new one only when the pinned reply no longer aligns.
function alignWords(run, words) {
  const target = run.target;
  if (target.kind === "selection") {
    return alignTokens(run, words, tokensFromRange(target.range, target.speechNorms));
  }
  if (target.kind === "message") return alignTokens(run, words, rootTokens(target.root, true));
  if (run.root !== null && run.root.isConnected) {
    const pinned = alignTokens(run, words, rootTokens(run.root, true));
    if (pinned !== null) return pinned;
  }
  const roots = recentReplyRoots(AUTO_CANDIDATES);
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    if (roots[i] === run.root) continue;
    const hit = tryAlign(words, rootTokens(roots[i], true), 0);
    if (hit !== null) {
      run.root = roots[i];
      return hit;
    }
  }
  return null;
}

// One warning per failed alignment, so a stuck caption run shows in the console.
function warnNoAlignment(spoken) {
  console.warn(
    "[copyspeech-hermes] captions: no alignment (" + spoken + " spoken words, no reply matched)"
  );
}

// Paint the word at `position`. Returns true while the fragment is aligned, even on a held gap.
function paintCaption(run, caption, position, fragmentIndex) {
  if (String(caption.text) !== caption.text || !Array.isArray(caption.words)) return false;
  const key = String(fragmentIndex) + "|" + caption.text;
  if (key !== run.key) {
    const words = captionWords(caption);
    const hit = alignWords(run, words);
    if (hit === null) {
      // A miss stores no key, so the next poll aligns again. The reply may still be rendering.
      run.key = null;
      run.map = null;
      if (run.warnedKey !== key) {
        run.warnedKey = key;
        warnNoAlignment(words.length);
      }
      return false;
    }
    run.key = key;
    run.words = words;
    run.tokens = hit.tokens;
    run.map = hit.detail.map;
    run.cursor = hit.detail.cursor;
  }
  if (run.map === null) return false;
  const active = activeWordIndex(run.words, position);
  // A gap between words holds the last painted word: no paint call, no clear.
  if (active < 0) return true;
  const index = run.map[active];
  const token = index >= 0 ? run.tokens[index] : undefined;
  if (token === undefined) return true;
  if (!tokenLive(token)) {
    // The reply's text changed under the run. Drop the alignment and its paint, then align on the next poll.
    run.key = null;
    run.map = null;
    run.pillToken = null;
    destroyPill();
    clearCaptionPaint();
    return false;
  }
  run.lastToken = token;
  followToken(run, token);
  paintToken(run, token);
  return true;
}

// Apply one status report to the run.
function onStatus(run, body) {
  if (activeRun !== run) return;
  // Re-check before painting: focus or settings may have changed while the request was pending.
  if (!syncRun(run)) {
    endRun(run);
    return;
  }
  // Mirror the app's pause state into the playback record, so the bar's glyph
  // follows a pause made in the CopySpeech window too. An optimistic flip keeps
  // its field for a moment, so an in-flight poll cannot flicker it.
  if (body !== null && run.requestId !== null && run.requestId === playback.requestId) {
    if (Date.now() - playback.pauseChangedAt >= PAUSE_RECONCILE_MS) {
      setPlaybackPaused(body.paused === true);
    }
  }
  const now = Date.now();
  const live = body !== null && body.active === true;
  // A live report keeps the run alive, even when its words do not align yet.
  if (live) {
    run.seenActive = true;
    run.lastSeen = now;
  }
  const caption = live ? body.captions : null;
  // Align only when a paint or the follow uses the words. A bar-only run skips it.
  const aligned =
    caption &&
    (run.mode !== "none" || run.follow) &&
    paintCaption(run, caption, body.position_ms, body.fragment_index);
  if (aligned) {
    run.lastSeen = now;
    run.endedPolls = 0;
    return;
  }
  // An inactive report with no captions is an end. One such report can be a
  // throttled or briefly stale webview report, so end only after two in a row.
  const ended = body !== null && !live && !body.captions;
  run.endedPolls = ended ? run.endedPolls + 1 : 0;
  const silent = now - run.lastSeen >= CAPTION_SILENCE_MS;
  if (silent || (run.seenActive && run.endedPolls >= 2)) endPlaybackRun(run);
}

// A natural end also clears the playback record when the ending run owns it,
// so the bar and the buttons retire with the reading. A run with no playback
// record (a test or a stale run) only stops its paint.
function endPlaybackRun(run) {
  if (run.requestId !== null && playback.requestId === run.requestId) forgetPlayback();
  else stopCaptions();
}

// A paint or alignment error must not escape the poll. The alignment is dropped,
// and the next poll aligns again.
function guardRun(run, step) {
  try {
    step();
  } catch (error) {
    if (!run.warnedError) {
      run.warnedError = true;
      console.warn("[copyspeech-hermes] captions: paint failed, aligning again", error);
    }
    run.key = null;
    run.map = null;
    run.pillToken = null;
    destroyPill();
    clearCaptionPaint();
  }
}

function pollCaptions(run) {
  guardRun(run, () => {
    if (activeRun !== run) return;
    // Check focus and settings before the busy return, so a pending request cannot hide a change.
    if (!syncRun(run)) {
      endRun(run);
      return;
    }
    if (run.busy) return;
    run.busy = true;
    void fetch(STATUS_URL, { mode: "cors", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((body) => {
        run.busy = false;
        guardRun(run, () => onStatus(run, body));
      });
  });
}

// Start one caption run. Captions and follow share the status poll; a new reading
// replaces the run. A target names what the run paints against: `latest` (auto
// read, pinned on its first match), `message` (a play-button read), or `selection`
// (a cloned range). Every plugin-started reading passes a request id, so its run is
// controlled: it keeps polling with paint off, because the same poll drives the
// bar's pause state and retires the bar when the reading ends.
export function startRun(ctx, settingsNow, sessionId, target, requestId) {
  stopCaptions();
  const current = settingsNow();
  const kind = target === undefined || target === null ? "latest" : target.kind;
  const id = requestId === undefined ? null : requestId;
  const controlled = kind !== "latest" || id !== null;
  const force = controlled && kind === "selection";
  // Glide paints with the pill, which needs no highlight API. Plain captions need it.
  const paints = current.captions && (current.glide || captionsSupported());
  // Follow needs no paint, so it runs where captions cannot paint.
  if (!controlled && !current.follow && !paints) return;
  const now = Date.now();
  const run = {
    key: null,
    words: [],
    tokens: [],
    map: null,
    cursor: 0,
    root: null,
    warnedKey: null,
    warnedError: false,
    busy: false,
    settings: settingsNow,
    sessionId: sessionId,
    requestId: id,
    target: {
      kind: kind,
      root: target?.root ?? null,
      range: target?.range ?? null,
      speechNorms: target?.speechNorms ?? null
    },
    controlled: controlled,
    forceCaptions: force,
    mode: paintMode({ forceCaptions: force }, current),
    follow: current.follow,
    scroller: null,
    watched: null,
    followPausedUntil: 0,
    lastScrollAt: 0,
    lastToken: null,
    pillToken: null,
    startedAt: now,
    lastSeen: now,
    seenActive: false,
    endedPolls: 0,
    dispose: null,
    pause: null,
    pauseKey: null,
    pauseScrollbar: null
  };
  run.pause = function () {
    run.followPausedUntil = Date.now() + FOLLOW_PAUSE_MS;
  };
  run.pauseKey = function (event) {
    if (FOLLOW_KEYS.has(event.key)) run.pause();
  };
  run.pauseScrollbar = function (event) {
    if (event.target === run.watched) run.pause();
  };
  const stopPoll = ctx.setInterval(() => pollCaptions(run), CAPTION_POLL_MS);
  run.dispose = function () {
    stopPoll();
    unwatchScroller(run);
    if (id !== null && playback.polled === id) playback.polled = null;
  };
  if (id !== null) playback.polled = id;
  activeRun = run;
}

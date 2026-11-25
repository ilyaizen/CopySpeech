import { playback } from "./state.js";
import { controlPost, stopReading } from "./transport.js";

// The playback record: the live reading, the surface that started it, and its
// pause state. Controls address the reading by request id.

const changeListeners = [];
const forgetListeners = [];

function removeFrom(list, item) {
  const at = list.indexOf(item);
  if (at >= 0) list.splice(at, 1);
}

// Runs after every change to the record. The bar and the message buttons repaint.
export function onPlaybackChange(listener) {
  changeListeners.push(listener);
  return () => removeFrom(changeListeners, listener);
}

// Runs when the record is forgotten. Captions stop with it.
export function onPlaybackForget(listener) {
  forgetListeners.push(listener);
  return () => removeFrom(forgetListeners, listener);
}

function emitChange() {
  for (const listener of changeListeners.slice()) listener();
}

export function rememberPlayback(source, requestId, root, range) {
  playback.requestId = requestId;
  playback.source = source;
  playback.root = root ?? null;
  playback.range = range ?? null;
  playback.paused = false;
  playback.pauseChangedAt = 0;
  emitChange();
}

export function forgetPlayback() {
  playback.requestId = null;
  playback.source = null;
  playback.root = null;
  playback.range = null;
  playback.paused = false;
  playback.pauseChangedAt = 0;
  playback.speakAbort = null;
  for (const listener of forgetListeners.slice()) listener();
  emitChange();
}

export function setPlaybackPaused(paused) {
  if (playback.paused === paused) return;
  playback.paused = paused;
  emitChange();
}

// Pause and resume address the live reading by request id. The glyph flips at
// once when a caption poll runs to confirm it. Without a poll there is nothing
// to reconcile against, so the request goes out alone.
export function pauseReading() {
  const requestId = playback.requestId;
  if (requestId === null) return Promise.resolve();
  if (playback.polled === requestId) {
    setPlaybackPaused(true);
    playback.pauseChangedAt = Date.now();
  }
  return controlPost("/pause", { request_id: requestId });
}

export function resumeReading() {
  const requestId = playback.requestId;
  if (requestId === null) return Promise.resolve();
  if (playback.polled === requestId) {
    setPlaybackPaused(false);
    playback.pauseChangedAt = Date.now();
  }
  return controlPost("/resume", { request_id: requestId });
}

// Rewind or skip one reading. Seek stays available while paused: the app moves
// the position, and a later resume plays from it.
export function seekReading(deltaMs) {
  const requestId = playback.requestId;
  if (requestId === null) return Promise.resolve();
  return controlPost("/seek", { request_id: requestId, delta_ms: deltaMs });
}

// Stop the live reading and clear every surface at once. The epoch bump also
// cancels a reading still queued behind an earlier start.
export function stopReadingNow() {
  const requestId = playback.requestId;
  playback.stopEpoch += 1;
  if (playback.speakAbort !== null) {
    playback.speakAbort.abort();
    playback.speakAbort = null;
  }
  if (requestId === null) {
    forgetPlayback();
    return Promise.resolve();
  }
  return stopReading(requestId).then(() => forgetPlayback());
}

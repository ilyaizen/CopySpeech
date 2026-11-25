// Shared mutable state. Modules read and write these fields. No module keeps
// its own copy, so the playback record has one owner.

export const playback = {
  // Id of the live reading, or null. Every control sends it.
  requestId: null,
  // Which surface started the live reading: "auto", "message", or "selection".
  source: null,
  // The reply a message read belongs to, or null.
  root: null,
  // The cloned range a selection read covers, or null.
  range: null,
  paused: false,
  // Time of the last optimistic pause flip. A poll may not override it for a moment.
  pauseChangedAt: 0,
  // Bumped by every stop. A start queued behind the stop sees the change and cancels.
  stopEpoch: 0,
  // Abort handle of the in-flight wait-mode /speak, or null.
  speakAbort: null,
  // Request id a caption run polls for, or null.
  polled: null
};

// Filled in by register(). The message buttons and the selection pill start reads through these.
export const hooks = {
  beginRead: null,
  settings: null
};

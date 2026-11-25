import { host } from "@hermes/plugin-sdk";
import { SPEAK_URL } from "./constants.js";
import { forgetPlayback } from "./playback.js";
import { playback } from "./state.js";

// Speech requests from auto-read and the offline notice. Every /speak in this
// plugin goes through here or through beginReading in index.js.

let notifiedDown = false;
let requestCounter = 0;

// One offline toast until a request succeeds again.
export function notifyOffline() {
  if (notifiedDown) return;
  notifiedDown = true;
  host.notify({ kind: "error", message: "CopySpeech not reachable on 127.0.0.1:43117" });
}

export function markReachable() {
  notifiedDown = false;
}

export function nextRequestId() {
  requestCounter += 1;
  return "hermes." + Date.now() + "." + requestCounter;
}

// Auto-read speech: no-cors and text/plain avoid a preflight. The request does
// not wait for playback. A failure also clears the playback record, so the bar
// never hangs on a dead request.
export function postSpeech(text, requestId) {
  return fetch(SPEAK_URL, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ text, request_id: requestId, wait: false })
  }).then(
    () => {
      markReachable();
    },
    (error) => {
      console.warn("[copyspeech-hermes] speak failed", error);
      notifyOffline();
      if (playback.requestId === requestId) forgetPlayback();
    }
  );
}

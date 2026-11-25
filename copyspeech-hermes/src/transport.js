import { CONTROL_URL, HEALTH_URL } from "./constants.js";

// Same transport as before: no-cors and text/plain avoid a preflight.
export function controlPost(path, body, signal) {
  return fetch(CONTROL_URL + path, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
    signal: signal
  }).then(
    () => true,
    () => false
  );
}

export function stopReading(requestId) {
  return controlPost("/stop", { request_id: requestId });
}

export async function probeCopySpeech() {
  try {
    await fetch(HEALTH_URL, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

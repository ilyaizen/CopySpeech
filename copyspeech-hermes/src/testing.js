// Test entry. build.mjs bundles it to test/under-test.mjs for the Node test.
// Hermes loads plugin.js, which exports only the default plugin object.
import { playback } from "./state.js";
import { currentRun } from "./captions/run.js";
import { currentPill } from "./captions/glide-pill.js";
import { forgetPlayback, rememberPlayback, stopReadingNow } from "./playback.js";
import { hooks } from "./state.js";

export { default } from "./index.js";
export {
  toSpeech,
  excerptSpeech,
  prepareSpeech,
  speechForRead,
  dropSkippedMarkup,
  speakVerdict,
  withClaim,
  BUILT_IN_REASON
} from "./speech.js";
export { normalizeSettings, clampCount, pendingEdits, draftView, applyEdit } from "./settings.js";
export { barStateFor } from "./ui/bar.js";
export { wordTokens, captionWords, activeWordIndex, alignDetail } from "./captions/words.js";
export { measureWord } from "./captions/geometry.js";
export { tokensFromRange, tokenRange, tokenLive } from "./captions/dom.js";
export { createGlidePill, livePillEnv } from "./captions/glide-pill.js";
export { pollPlan, startRun, stopCaptions } from "./captions/run.js";
export { makeMessageButton } from "./ui/message-buttons.js";
export { selectionInsideReply } from "./ui/selection.js";
export { rememberPlayback as playbackRemember, stopReadingNow, hooks };

export function liveCaptionRun() {
  return currentRun();
}

export function livePill() {
  return currentPill();
}

export function playbackRequestIdNow() {
  return playback.requestId;
}

export function clearPlayback() {
  forgetPlayback();
}

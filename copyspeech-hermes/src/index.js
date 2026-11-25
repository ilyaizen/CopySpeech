import { PALETTE_AREA, atom, host } from "@hermes/plugin-sdk";
import { jsx } from "react/jsx-runtime";
import { focusedSession } from "./captions/dom.js";
import { startRun, stopCaptions } from "./captions/run.js";
import { wordNorms } from "./captions/words.js";
import { ID, SETTINGS_KEY } from "./constants.js";
import { markReachable, nextRequestId, notifyOffline, postSpeech } from "./control.js";
import {
  forgetPlayback,
  onPlaybackChange,
  onPlaybackForget,
  rememberPlayback,
  stopReadingNow
} from "./playback.js";
import { builtInAutoSpeakOn, readSettings, saveSettings } from "./settings.js";
import {
  BUILT_IN_REASON,
  claimKey,
  prepareSpeech,
  readClaims,
  speakVerdict,
  speechForRead,
  withClaim
} from "./speech.js";
import { hooks, playback } from "./state.js";
import { controlPost, stopReading } from "./transport.js";
import { COMPOSER_TOP_AREA, PlaybackBar, createBarAtom, updateBar } from "./ui/bar.js";
import {
  hideMessageTooltip,
  installMessageButtons,
  removeMessageButtons,
  syncMessageButtons
} from "./ui/message-buttons.js";
import { dismissSelectionPill, onSelectionChange } from "./ui/selection.js";
import { SettingsPage } from "./ui/settings-page.js";
import { installCaptionStyle, installUiStyle } from "./ui/style.js";

// CopySpeech auto-read for Hermes Desktop.
// Reads each new completed assistant reply through the running CopySpeech app.
// Manual control: a play button on every reply (hover its action row), a
// "Read aloud" pill on text selected inside a reply, and a playback bar above
// the chat input (pause, resume, back and forward 5 seconds, stop, show in chat)
// for any reading this plugin started, automatic ones included.
// Optional: highlights the word CopySpeech speaks inside the reply (CSS Custom
// Highlight API, or a gliding pill when "Glide between words" is on). Manual
// reads paint too. Optional: follows the spoken word, scrolling the reply to
// keep it in view.

function uiAvailable() {
  return window.MutationObserver !== undefined && window.document !== undefined;
}

export default {
  id: ID,
  name: "CopySpeech",
  description: "Reads new completed Hermes replies aloud through the running CopySpeech app.",
  register(ctx) {
    const storage = ctx.storage;
    const settings = atom(readSettings(storage));
    const armed = new Set();
    const style = installCaptionStyle();
    const ui = uiAvailable();
    hooks.settings = () => readSettings(storage);
    let uiStyle = null;
    if (ui) uiStyle = installUiStyle();
    const barAtom = createBarAtom();
    const unsubscribes = [
      onPlaybackChange(updateBar),
      onPlaybackChange(syncMessageButtons),
      onPlaybackForget(stopCaptions)
    ];

    // Start one controlled reading: a message play-button read or a selection
    // read. Calls queue through the chain, so overlapping starts cannot post two
    // /speak calls around one stop. A stop bumps the epoch and cancels a start
    // still queued behind it.
    let beginChain = Promise.resolve();
    const beginReading = (plan) => {
      const epoch = playback.stopEpoch;
      const run = () => {
        if (epoch !== playback.stopEpoch) return Promise.resolve(null);
        const previous = playback.requestId;
        const stopping = previous === null ? Promise.resolve(true) : stopReading(previous);
        return stopping.then((stopped) => {
          // A stop pressed while this start waited on the previous stop cancels it.
          // Without this check, the queued read would reach /speak after the stop.
          if (epoch !== playback.stopEpoch) return null;
          if (!stopped) {
            notifyOffline();
            return "error.offline";
          }
          const requestId = nextRequestId();
          const selection = plan.source === "selection";
          const speech = speechForRead(plan.source, plan.speech, readSettings(storage));
          if (speech === "") {
            host.notify({
              kind: "warning",
              message: "Nothing to read aloud after skipping bullets and sections"
            });
            return null;
          }
          rememberPlayback(
            plan.source,
            requestId,
            selection ? null : (plan.root ?? null),
            selection ? (plan.range ?? null) : null
          );
          const target = selection
            ? { kind: "selection", range: plan.range ?? null, speechNorms: wordNorms(speech) }
            : { kind: "message", root: plan.root ?? null };
          startRun(ctx, () => readSettings(storage), focusedSession(), target, requestId);
          const controller = new AbortController();
          playback.speakAbort = controller;
          void controlPost(
            "/speak",
            { text: speech, request_id: requestId, wait: true },
            controller.signal
          ).then((sent) => {
            if (playback.speakAbort === controller) playback.speakAbort = null;
            if (sent) markReachable();
            if (playback.requestId !== requestId) return null;
            forgetPlayback();
            // An aborted request is the stop the user asked for, not a failure.
            if (controller.signal.aborted) return null;
            if (!sent) {
              notifyOffline();
              return "error.offline";
            }
            return null;
          });
        });
      };
      const next = beginChain.then(run, run);
      beginChain = next;
      return next;
    };
    hooks.beginRead = beginReading;

    ctx.onDispose(() => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      hooks.beginRead = null;
      hooks.settings = null;
      // Unloading the plugin stops its reading, not just the paint.
      if (playback.speakAbort !== null) {
        playback.speakAbort.abort();
        playback.speakAbort = null;
      }
      const requestId = playback.requestId;
      if (requestId !== null) void stopReading(requestId);
      forgetPlayback();
      if (ui) {
        removeMessageButtons();
        dismissSelectionPill();
        if (uiStyle !== null) {
          uiStyle.remove();
          uiStyle = null;
        }
      }
      stopCaptions();
      style.remove();
    });
    ctx.addEventListener(window, "storage", (event) => {
      if (event.key === null || event.key === SETTINGS_KEY) {
        settings.set(readSettings(storage));
        syncUi();
      }
    });

    // The injected UI follows the saved settings: buttons and the pill can be
    // turned off. The bar is a composer contribution and shows only while a reading plays.
    function syncUi() {
      if (!ui) return;
      const current = readSettings(storage);
      if (current.messageButtons) installMessageButtons();
      else removeMessageButtons();
      if (!current.selectionRead) dismissSelectionPill();
    }
    syncUi();
    if (ui) {
      ctx.addEventListener(document, "selectionchange", () => {
        onSelectionChange();
      });
      ctx.addEventListener(
        window,
        "scroll",
        () => {
          dismissSelectionPill();
          hideMessageTooltip();
        },
        { capture: true, passive: true }
      );
      ctx.addEventListener(
        window,
        "keydown",
        (event) => {
          if (event.key === "Escape") dismissSelectionPill();
        },
        { capture: true }
      );
    }

    ctx.onEvent("message.start", (event) => {
      if (event && event.session_id) armed.add(event.session_id);
    });

    ctx.onEvent("message.complete", (event) => {
      const current = readSettings(storage);
      settings.set(current);
      const verdict = speakVerdict(event, {
        settings: current,
        focusedSessionId: focusedSession(),
        armed,
        claims: readClaims(storage),
        builtInOn: builtInAutoSpeakOn()
      });
      if (!verdict.speak) {
        if (verdict.reason === BUILT_IN_REASON) {
          console.info("[copyspeech-hermes] skipped reply: Hermes built-in auto-read is on");
        }
        return;
      }
      const speech = prepareSpeech(String(event.payload.text || ""), current);
      if (!speech) return;
      storage.set("claims", withClaim(readClaims(storage), claimKey(event), Date.now()));
      // Speech starts first. Captions only follow it, so they never delay speech.
      const requestId = nextRequestId();
      rememberPlayback("auto", requestId, null, null);
      void postSpeech(speech, requestId);
      // Every auto read gets a run. Its poll retires the bar when the reading ends.
      startRun(ctx, () => readSettings(storage), event.session_id, null, requestId);
    });

    ctx.register({
      id: "playback-bar",
      area: COMPOSER_TOP_AREA,
      render: () => jsx(PlaybackBar, { barAtom: barAtom })
    });

    ctx.register({
      id: "toggle-auto-read",
      area: PALETTE_AREA,
      data: {
        id: ID + ".toggle-auto-read",
        label: "CopySpeech: Toggle auto-read",
        keywords: ["copyspeech", "copyspeech", "speak", "read", "aloud", "tts"],
        run: () => {
          const next = !readSettings(storage).autoRead;
          saveSettings(storage, settings, { autoRead: next });
          host.notify({
            kind: "info",
            message: next ? "CopySpeech auto-read is on" : "CopySpeech auto-read is off"
          });
        }
      }
    });

    ctx.register({
      id: "stop-reading",
      area: PALETTE_AREA,
      data: {
        id: ID + ".stop-reading",
        label: "CopySpeech: Stop reading",
        keywords: ["copyspeech", "stop", "tts", "speak"],
        run: () => {
          void stopReadingNow();
        }
      }
    });

    ctx.registerSettingsPage({
      id: ID,
      title: "CopySpeech",
      render: () => jsx(SettingsPage, { storage, settings })
    });

    console.info("[copyspeech-hermes] registered");
  }
};

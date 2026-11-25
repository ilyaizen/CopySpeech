import { atom, useValue } from "@hermes/plugin-sdk";
import { jsx, jsxs } from "react/jsx-runtime";
import { findScroller, motionBehavior, tokenLive, tokenRange } from "../captions/dom.js";
import { firstPaintedRect } from "../captions/geometry.js";
import { currentRun } from "../captions/run.js";
import { FOLLOW_ANCHOR, SEEK_STEP_MS } from "../constants.js";
import { pauseReading, resumeReading, seekReading, stopReadingNow } from "../playback.js";
import { playback } from "../state.js";
import { ICON_BACK, ICON_CHAT, ICON_FORWARD, ICON_PAUSE, ICON_PLAY, ICON_STOP } from "./icons.js";

export const COMPOSER_TOP_AREA = "composer.top";

// Pure: what the bar shows for the current reading.
export function barStateFor(requestId, paused) {
  const active = requestId !== null;
  return { active: active, paused: active && paused };
}

// updateBar() writes this atom. PlaybackBar subscribes to it. register() creates it, like the settings atom.
let barState = null;

function barGlyph(icon, size) {
  const stroke = icon.stroked === true ? String(3.3 * (17 / size)) : null;
  return jsx("svg", {
    viewBox: icon.viewBox,
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    children: icon.paths.map((d, i) =>
      jsx("path", {
        key: i,
        d: d,
        ...(stroke !== null
          ? {
              fill: "none",
              stroke: "currentColor",
              strokeWidth: stroke,
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          : { fill: "currentColor" })
      })
    )
  });
}

function barButton(label, icon, onClick, extraClass) {
  return jsx("button", {
    type: "button",
    className: extraClass ? "csh-bar-btn " + extraClass : "csh-bar-btn",
    "aria-label": label,
    title: label,
    onClick: onClick,
    children: barGlyph(icon, 15)
  });
}

export function PlaybackBar({ barAtom }) {
  const state = useValue(barAtom);
  if (!state.active) return null;
  const label = state.paused ? "Resume reading" : "Pause reading";
  return jsxs("div", {
    className: "csh-bar",
    role: "region",
    "aria-label": "CopySpeech playback",
    children: [
      barButton(label, state.paused ? ICON_PLAY : ICON_PAUSE, () => {
        void (playback.paused ? resumeReading() : pauseReading());
      }),
      barButton("Back 5 seconds", ICON_BACK, () => {
        void seekReading(-SEEK_STEP_MS);
      }),
      barButton("Forward 5 seconds", ICON_FORWARD, () => {
        void seekReading(SEEK_STEP_MS);
      }),
      barButton(
        "Stop reading",
        ICON_STOP,
        () => {
          void stopReadingNow();
        },
        "csh-bar-stop"
      ),
      barButton("Show the spoken word", ICON_CHAT, () => {
        showPlaybackInChat();
      })
    ]
  });
}

export function updateBar() {
  if (barState === null) return;
  barState.set(barStateFor(playback.requestId, playback.paused));
}

// The bar's Show-in-chat control: bring the spoken word's line to the anchor.
// With no aligned word yet, it brings the reading's target into view instead.
function showPlaybackInChat() {
  const run = currentRun();
  let element = null;
  let range = null;
  if (run !== null && run.lastToken !== null && tokenLive(run.lastToken)) {
    element = run.lastToken.node.parentElement;
    range = tokenRange(run.lastToken);
  } else if (playback.root !== null && playback.root.isConnected) {
    element = playback.root;
  } else if (playback.range !== null && playback.range.startContainer.isConnected) {
    element = playback.range.startContainer.parentElement;
    range = playback.range;
  }
  if (element === null) return;
  const scroller = findScroller(element);
  if (scroller === null) {
    element.scrollIntoView({ block: "center", behavior: motionBehavior() });
    return;
  }
  const rect =
    range !== null
      ? (firstPaintedRect(range) ?? range.getBoundingClientRect())
      : element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const box = scroller.getBoundingClientRect();
  const offset = rect.top - box.top - box.height * FOLLOW_ANCHOR;
  scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: motionBehavior() });
}

// The bar's atom. updateBar writes it, and PlaybackBar subscribes to it.
export function createBarAtom() {
  barState = atom(barStateFor(playback.requestId, playback.paused));
  return barState;
}

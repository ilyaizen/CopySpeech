import { host } from "@hermes/plugin-sdk";
import { DEFAULTS, MESSAGE_BODY_SELECTOR, MESSAGE_ROOT_SELECTOR } from "../constants.js";
import { toSpeech } from "../speech.js";
import { hooks } from "../state.js";

// ---- The selection read pill ----

let selectionPill = null;
let selectionTimer = null;

export function dismissSelectionPill() {
  if (selectionPill === null) return;
  selectionPill.el.remove();
  selectionPill = null;
}

function positionSelectionPill(range) {
  if (selectionPill === null) return;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) {
    dismissSelectionPill();
    return;
  }
  const last = rects[rects.length - 1];
  const above = last.top > 52;
  const top = above ? last.top - 44 : last.bottom + 8;
  const left = Math.max(8, Math.min(last.right - 60, window.innerWidth - 150));
  selectionPill.el.style.top = Math.max(8, top) + "px";
  selectionPill.el.style.left = left + "px";
}

function showSelectionPill(range) {
  if (selectionPill === null) {
    const el = document.createElement("div");
    el.className = "csh-pill";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "csh-pill-btn";
    button.textContent = "Read aloud";
    // A pointer-down on the pill must not collapse the selection before the
    // click can clone its range.
    el.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      readSelectedRange();
    });
    el.appendChild(button);
    document.documentElement.appendChild(el);
    selectionPill = { el: el, button: button, range: range };
  } else {
    selectionPill.range = range;
  }
  positionSelectionPill(range);
}

export function selectionInsideReply(range) {
  const node = range.startContainer;
  const anchor = node.nodeType === 1 ? node : node.parentElement;
  if (anchor === null) return false;
  return (
    anchor.closest(MESSAGE_BODY_SELECTOR) !== null && anchor.closest(MESSAGE_ROOT_SELECTOR) !== null
  );
}

function updateSelectionPill() {
  const settings = hooks.settings === null ? DEFAULTS : hooks.settings();
  if (!settings.selectionRead) {
    dismissSelectionPill();
    return;
  }
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) {
    dismissSelectionPill();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!selectionInsideReply(range)) {
    dismissSelectionPill();
    return;
  }
  showSelectionPill(range);
}

// selectionchange fires per drag movement; one trailing run per 120 ms.
export function onSelectionChange() {
  if (selectionTimer !== null) return;
  selectionTimer = window.setTimeout(() => {
    selectionTimer = null;
    updateSelectionPill();
  }, 120);
}

function readSelectedRange() {
  if (hooks.beginRead === null || selectionPill === null) return;
  const range = selectionPill.range;
  dismissSelectionPill();
  if (range === null || !range.startContainer.isConnected) return;
  const speech = toSpeech(range.toString());
  const selection = window.getSelection();
  if (selection !== null) selection.removeAllRanges();
  if (speech === "") {
    host.notify({ kind: "warning", message: "Nothing to read aloud in this selection" });
    return;
  }
  hooks.beginRead({ source: "selection", speech: speech, range: range });
}

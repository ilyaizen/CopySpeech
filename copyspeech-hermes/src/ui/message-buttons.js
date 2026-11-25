import { host } from "@hermes/plugin-sdk";
import {
  MESSAGE_ACTIONS_SELECTOR,
  MESSAGE_BODY_SELECTOR,
  MESSAGE_ROOT_SELECTOR,
  PLAY_BUTTON_FLAG,
  REASONING_SELECTOR
} from "../constants.js";
import { stopReadingNow } from "../playback.js";
import { toSpeech } from "../speech.js";
import { hooks, playback } from "../state.js";
import { ICON_SPEAKER, ICON_STOP_MESSAGE, svgGlyph } from "./icons.js";

// ---- Message play buttons ----

const messageButtonSyncs = new Set();
let messageTooltip = null;
let messageTooltipTimer = null;
let messageTooltipPending = null;

export function hideMessageTooltip() {
  if (messageTooltipTimer !== null) {
    window.clearTimeout(messageTooltipTimer);
    messageTooltipTimer = null;
  }
  messageTooltipPending = null;
  if (messageTooltip !== null) {
    messageTooltip.el.remove();
    messageTooltip = null;
  }
}

function showMessageTooltip(button) {
  hideMessageTooltip();
  messageTooltipPending = button;
  messageTooltipTimer = window.setTimeout(() => {
    messageTooltipTimer = null;
    messageTooltipPending = null;
    if (!button.isConnected) return;
    const el = document.createElement("div");
    el.className = "csh-tooltip";
    el.setAttribute("role", "tooltip");
    el.textContent = button.getAttribute("aria-label");
    document.documentElement.appendChild(el);
    const target = button.getBoundingClientRect();
    const tip = el.getBoundingClientRect();
    const top = target.top - tip.height - 5;
    el.style.top = (top >= 8 ? top : target.bottom + 5) + "px";
    el.style.left =
      Math.max(
        8,
        Math.min(target.left + (target.width - tip.width) / 2, window.innerWidth - tip.width - 8)
      ) + "px";
    messageTooltip = { el: el, button: button };
  }, 200);
}

let buttonsObserver = null;
let scanQueued = false;

// The reply's rendered text for speech: the Markdown bodies' words, minus
// reasoning and code blocks, joined as paragraphs.
function spokenTextFromRoot(root) {
  const parts = [];
  for (const body of root.querySelectorAll(MESSAGE_BODY_SELECTOR)) {
    if (body.closest(REASONING_SELECTOR) !== null) continue;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement !== null && node.parentElement.closest("pre") !== null) continue;
      parts.push(node.nodeValue ?? "");
    }
    parts.push("\n\n");
  }
  return toSpeech(parts.join(""));
}

export function makeMessageButton(root) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "csh-msg-play";
  button.setAttribute(PLAY_BUTTON_FLAG, "");
  const sync = () => {
    const active = playback.source === "message" && playback.root === root;
    const label = active ? "Stop CopySpeech reading" : "Read aloud with CopySpeech";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    if (messageTooltip !== null && messageTooltip.button === button) {
      messageTooltip.el.textContent = label;
    }
    button.dataset.active = active ? "true" : "false";
    button.replaceChildren(svgGlyph(active ? ICON_STOP_MESSAGE : ICON_SPEAKER, 15));
  };
  button.addEventListener("pointerenter", () => showMessageTooltip(button));
  button.addEventListener("pointerleave", () => {
    if (!button.matches(":focus-visible")) hideMessageTooltip();
  });
  button.addEventListener("focus", () => {
    if (button.matches(":focus-visible")) showMessageTooltip(button);
  });
  button.addEventListener("blur", hideMessageTooltip);
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideMessageTooltip();
  });
  button.addEventListener("click", () => {
    if (playback.source === "message" && playback.root === root) {
      void stopReadingNow();
      return;
    }
    if (hooks.beginRead === null) return;
    const speech = spokenTextFromRoot(root);
    if (speech === "") {
      host.notify({ kind: "warning", message: "Nothing to read aloud in this reply" });
      return;
    }
    hooks.beginRead({ source: "message", speech: speech, root: root });
  });
  messageButtonSyncs.add({ button: button, sync: sync });
  sync();
  return button;
}

// One injected button per hover action row. The row belongs to a settled
// reply, so buttons appear when replies finish and ride virtualization.
function scanMessageRows() {
  if (messageTooltip !== null && !messageTooltip.button.isConnected) hideMessageTooltip();
  if (messageTooltipPending !== null && !messageTooltipPending.isConnected) hideMessageTooltip();
  for (const entry of messageButtonSyncs) {
    if (!entry.button.isConnected) messageButtonSyncs.delete(entry);
  }
  for (const row of document.querySelectorAll(MESSAGE_ACTIONS_SELECTOR)) {
    if (row.querySelector("button[" + PLAY_BUTTON_FLAG + "]") !== null) continue;
    const root = row.closest(MESSAGE_ROOT_SELECTOR);
    if (root === null) continue;
    row.appendChild(makeMessageButton(root));
  }
}

function scheduleScan() {
  if (scanQueued || buttonsObserver === null) return;
  scanQueued = true;
  window.requestAnimationFrame(() => {
    scanQueued = false;
    scanMessageRows();
  });
}

export function installMessageButtons() {
  if (buttonsObserver !== null || window.MutationObserver === undefined) return;
  buttonsObserver = new window.MutationObserver(scheduleScan);
  buttonsObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanMessageRows();
}

export function removeMessageButtons() {
  hideMessageTooltip();
  if (buttonsObserver !== null) {
    buttonsObserver.disconnect();
    buttonsObserver = null;
  }
  for (const button of document.querySelectorAll("button[" + PLAY_BUTTON_FLAG + "]")) {
    button.remove();
  }
  messageButtonSyncs.clear();
}

export function syncMessageButtons() {
  for (const entry of messageButtonSyncs) {
    if (entry.button.isConnected) entry.sync();
    else messageButtonSyncs.delete(entry);
  }
}

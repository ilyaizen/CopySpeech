import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { fetchUrlText, flush, mod, plugin, test } from "./harness.mjs";

test("message button has a label on insertion and can switch to stop", () => {
  const dom = new JSDOM(
    '<div data-slot="aui_assistant-message-root" data-role="assistant"><div class="aui-message-actions-desktop"></div></div>'
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const root = document.querySelector('[data-role="assistant"]');
  const row = document.querySelector(".aui-message-actions-desktop");
  const button = mod.makeMessageButton(root);
  row.appendChild(button);
  assert.equal(button.getAttribute("aria-label"), "Read aloud with CopySpeech");
  mod.playbackRemember("message", "test-id", root, null);
  assert.equal(button.getAttribute("aria-label"), "Stop CopySpeech reading");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  const stopPath = button.querySelector("path");
  assert.equal(stopPath.getAttribute("stroke"), "currentColor");
  assert.equal(stopPath.getAttribute("fill"), "none");
  mod.clearPlayback();
  assert.equal(button.getAttribute("aria-label"), "Read aloud with CopySpeech");
  dom.window.close();
});

test("message button shows a themed tooltip on hover and hides it on leave", async () => {
  const dom = new JSDOM(
    '<div data-slot="aui_assistant-message-root" data-role="assistant"><div class="aui-message-actions-desktop"></div></div>',
    { pretendToBeVisual: true }
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const root = document.querySelector('[data-role="assistant"]');
  const button = mod.makeMessageButton(root);
  document.querySelector(".aui-message-actions-desktop").appendChild(button);
  button.dispatchEvent(new dom.window.Event("pointerenter"));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 250));
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.ok(tooltip, "hover shows a tooltip");
  assert.equal(tooltip.textContent, "Read aloud with CopySpeech");
  mod.playbackRemember("message", "tooltip-test", root, null);
  assert.equal(tooltip.textContent, "Stop CopySpeech reading");
  button.dispatchEvent(new dom.window.Event("pointerleave"));
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  mod.clearPlayback();
  dom.window.close();
});

test("selection can start at a reply paragraph boundary", () => {
  const dom = new JSDOM(
    '<div data-slot="aui_assistant-message-root" data-role="assistant"><div class="aui-md"><p>First</p><p>Second</p></div></div>'
  );
  const body = dom.window.document.querySelector(".aui-md");
  const range = dom.window.document.createRange();
  range.setStart(body, 0);
  range.setEnd(body.lastChild.firstChild, 6);
  assert.equal(mod.selectionInsideReply(range), true);
  dom.window.close();
});

test("clicking another reply replaces a manual reading still waiting for completion", async () => {
  const dom = new JSDOM(
    '<div data-slot="aui_assistant-message-root" data-role="assistant"><div class="aui-md">First reply</div><div class="aui-message-actions-desktop"></div></div>' +
      '<div data-slot="aui_assistant-message-root" data-role="assistant"><div class="aui-md">Second reply</div><div class="aui-message-actions-desktop"></div></div>',
    { url: "https://hermes.local", pretendToBeVisual: true }
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  globalThis.host = { state: { focusedSessionId: { get: () => "s1" } }, notify() {} };
  const requests = [];
  globalThis.fetch = (url, options) => {
    requests.push({ url: fetchUrlText(url), body: JSON.parse(options.body) });
    if (fetchUrlText(url).endsWith("/speak")) return new Promise(() => {});
    return Promise.resolve({ ok: true });
  };
  const disposers = [];
  const ctx = {
    storage: { get: (_key, fallback) => fallback, set() {} },
    onEvent() {},
    onDispose(fn) {
      disposers.push(fn);
    },
    addEventListener() {},
    setInterval() {
      return () => {};
    },
    register() {},
    registerSettingsPage() {}
  };
  plugin.register(ctx);
  const buttons = document.querySelectorAll("[data-copyspeech-play]");
  assert.equal(buttons.length, 2);
  buttons[0].click();
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.text, "First reply");
  assert.equal(requests[0].body.wait, true);
  buttons[1].click();
  await flush();
  assert.equal(requests.length, 3, "replacement must stop the first request and start the second");
  assert.ok(requests[1].url.endsWith("/stop"));
  assert.equal(requests[1].body.request_id, requests[0].body.request_id);
  assert.equal(requests[2].body.text, "Second reply");
  for (const dispose of disposers) dispose();
  dom.window.close();
});

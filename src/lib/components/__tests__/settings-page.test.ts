// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { tick } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { waitForI18nReady } from "#lib/i18n";
import { testConfig } from "#lib/test-fixtures/app-config";
import { saveBar } from "#lib/stores/save-bar.svelte";
import { AUTO_SAVE_DEBOUNCE_MS } from "#lib/stores/auto-save.svelte";
import type { AppConfig } from "#lib/types";
import SettingsPage from "../settings-page.svelte";
import { tauriService } from "#lib/services/tauri";
import * as externalLink from "#lib/utils/external-link";

let config: AppConfig;
let saved: AppConfig[];
let intersect: IntersectionObserverCallback;
const scrollIntoView = vi.fn();

beforeAll(async () => {
  await waitForI18nReady();
});

beforeEach(() => {
  const motion = new EventTarget();
  Object.defineProperty(motion, "matches", { value: false });
  vi.stubGlobal("matchMedia", () => motion);
  config = testConfig();
  saved = [];
  mockIPC(
    (cmd, payload) => {
      if (cmd === "get_config") return structuredClone(config);
      if (cmd === "set_config") {
        // SAFETY: this test backend only receives Settings' typed set_config payload.
        saved.push(JSON.parse(JSON.stringify((payload as { newConfig: AppConfig }).newConfig)));
      }
      if (cmd === "reset_config") config = testConfig();
      return null;
    },
    { shouldMockEvents: true }
  );
  vi.spyOn(tauriService, "invoke").mockImplementation(invoke);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView
  });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  );
});

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  scrollIntoView.mockClear();
});

async function mountSettings() {
  const view = render(SettingsPage);
  await view.findByRole("navigation");
  return view;
}

it("shows System alongside explicit languages and saves both separately", async () => {
  config.general.locale = "en";
  vi.spyOn(navigator, "language", "get").mockReturnValue("he-IL");
  const view = await mountSettings();
  const select = view.container.querySelector("#language");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Language selector missing");
  expect(select.options[0].textContent).toBe("System");
  expect(select.options[0].value).toBe("");
  expect(select.value).toBe("en");

  await fireEvent.change(select, { target: { value: "" } });
  expect(select.value).toBe("");
  await saveBar.onSave?.();
  expect(saved.at(-1)?.general.locale).toBe("");

  await fireEvent.change(select, { target: { value: "en" } });
  await saveBar.onSave?.();
  expect(saved.at(-1)?.general.locale).toBe("en");
});

it("uses the shared app scroller for sidebar navigation and keeps cloned provider links clickable", async () => {
  const scrollTo = vi.fn();
  const resize = vi.fn();
  const view = render(SettingsPage, {
    context: new Map([["app-lenis", () => ({ scrollTo, dimensions: { resize } })]])
  });
  const nav = await view.findByRole("navigation");
  const misc = within(nav).getByRole("button", { name: "Misc" });
  await fireEvent.click(misc);
  expect(misc.getAttribute("aria-current")).toBe("page");
  expect(resize).toHaveBeenCalled();
  expect(scrollTo).toHaveBeenCalledWith(view.container.querySelector("#about"));
  expect(scrollIntoView).not.toHaveBeenCalled();

  const clone = view.container.querySelector('ul[aria-hidden="true"] a[tabindex="-1"]');
  if (!(clone instanceof HTMLAnchorElement)) throw new Error("Cloned provider link missing");
  const openExternal = vi.spyOn(externalLink, "openExternal").mockResolvedValue();
  await fireEvent.click(clone);
  expect(openExternal).toHaveBeenCalledWith(clone.href);
});

it("scrolls instantly from the sidebar when reduced motion is enabled", async () => {
  const motion = new EventTarget();
  Object.defineProperty(motion, "matches", { value: true });
  vi.stubGlobal("matchMedia", () => motion);
  const view = await mountSettings();
  await fireEvent.click(within(view.getByRole("navigation")).getByRole("button", { name: "Misc" }));
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
});

it("keeps hidden-start and close-to-tray preferences but disables them without a tray", async () => {
  config.general.show_tray_icon = true;
  config.general.start_minimized = true;
  config.general.close_behavior = "minimize-to-tray";
  const view = await mountSettings();
  const showTray = view.getByRole("switch", { name: "Show Tray Icon" });
  const startInTray = view.getByRole("switch", { name: "Start in Tray" });
  const closeToTray = view.getByRole("switch", { name: "Close to Tray" });
  await fireEvent.click(showTray);
  expect(startInTray.hasAttribute("disabled")).toBe(true);
  expect(closeToTray.hasAttribute("disabled")).toBe(true);
  expect(startInTray.getAttribute("aria-checked")).toBe("true");
  expect(closeToTray.getAttribute("aria-checked")).toBe("true");
  await fireEvent.click(showTray);
  expect(startInTray.hasAttribute("disabled")).toBe(false);
  expect(closeToTray.hasAttribute("disabled")).toBe(false);
});

it("gates experimental features and detail sections while preserving legacy preferences", async () => {
  config.history.enabled = true;
  config.post_process.enabled = true;
  config.playback.duck.enabled = true;
  config.hud.enabled = true;
  config.hotkey.enabled = true;
  const view = await mountSettings();
  const nav = within(view.getByRole("navigation"));
  expect(nav.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
    "General",
    "Playback",
    "Advanced",
    "Misc"
  ]);
  expect(view.container.querySelector("#advanced #playback-streaming")).not.toBeNull();
  expect(view.container.querySelector("#history")).toBeNull();
  expect(view.container.querySelector("#postProcess")).toBeNull();
  expect(view.container.querySelector("#hud-enabled")).toBeNull();
  expect(view.container.querySelector("#hotkey-enabled")).toBeNull();
  expect(view.container.querySelector("#auto-save-profiles")).toBeNull();

  const experimental = view.getByRole("switch", { name: "Experimental Features (Alpha)" });
  await fireEvent.click(experimental);
  const hotkey = view.container.querySelector("#hotkey-enabled")!;
  expect(hotkey.getAttribute("aria-checked")).toBe("true");
  expect(view.container.querySelector("#hotkey-input")).not.toBeNull();
  expect(view.container.querySelectorAll("#history-enabled")).toHaveLength(1);
  expect(view.container.querySelectorAll("#post-process-enabled")).toHaveLength(1);
  expect(view.container.querySelector("#hud-position")).not.toBeNull();
  expect(view.container.querySelector("#history")).not.toBeNull();
  expect(view.container.querySelector("#postProcess textarea")).not.toBeNull();

  await fireEvent.click(nav.getByRole("button", { name: "History" }));
  await fireEvent.click(view.container.querySelector("#history-enabled")!);
  await tick();
  expect(nav.queryByRole("button", { name: "History" })).toBeNull();
  expect(nav.getByRole("button", { name: "Advanced" }).getAttribute("aria-current")).toBe("page");
  expect(document.activeElement?.id).toBe("advanced");

  await fireEvent.click(experimental);
  expect(view.container.querySelector("#postProcess")).toBeNull();
  expect(view.container.querySelector("#hotkey-enabled")).toBeNull();
  await fireEvent.click(experimental);
  expect(view.container.querySelector("#postProcess")).not.toBeNull();
});

it("shows Duck in Playback on Windows and hides it on macOS without clearing its preference", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
  config.general.experimental_enabled = false;
  config.playback.duck.enabled = true;
  const winView = await mountSettings();
  expect(winView.container.querySelector("#playback #playback-duck")).not.toBeNull();
  expect(winView.container.querySelector("#playback #duck-level")).not.toBeNull();
  expect(winView.container.querySelector("#advanced #playback-duck")).toBeNull();
  winView.unmount();

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh)");
  const macView = await mountSettings();
  expect(macView.container.querySelector("#playback-duck")).toBeNull();
  await fireEvent.click(macView.container.querySelector("#playback-streaming")!);
  await saveBar.onSave?.();
  expect(saved[0].playback.duck.enabled).toBe(true);
});

it("shows Animate Captions in Appearance only while Animations is on", async () => {
  config.playback.caption_animation = true;
  const view = await mountSettings();
  const captions = view.getByRole("switch", { name: "Animate Captions" });
  const general = view.container.querySelector("#general");
  if (!(general instanceof HTMLElement)) throw new Error("General section missing");
  expect(general.contains(captions)).toBe(true);
  expect(view.container.querySelector("#playback #caption-animation")).toBeNull();
  const animations = view.getByRole("switch", { name: "Animations" });
  await fireEvent.click(animations);
  expect(view.queryByRole("switch", { name: "Animate Captions" })).toBeNull();
  await fireEvent.click(animations);
  expect(view.getByRole("switch", { name: "Animate Captions" })).toBeTruthy();
});

it("serializes only valid retrigger values through Save and restores changes on Cancel", async () => {
  const view = await mountSettings();
  const select = view.container.querySelector<HTMLSelectElement>("#retrigger-mode")!;
  expect(Array.from(select.options, (option) => option.value)).toEqual(["interrupt", "queue"]);
  await fireEvent.change(select, { target: { value: "queue" } });
  expect(saveBar.visible).toBe(true);
  saveBar.onCancel?.();
  await tick();
  expect(select.value).toBe("interrupt");
  expect(saveBar.visible).toBe(false);
  await fireEvent.change(select, { target: { value: "queue" } });
  await saveBar.onSave?.();
  expect(saved.at(-1)?.playback.on_retrigger).toBe("queue");
});

it("auto-saves only when Experimental is enabled and keeps legacy opt-in preferences", async () => {
  config.general.auto_save_profiles = true;
  config.general.experimental_enabled = false;
  config.history.enabled = true;
  config.post_process.enabled = true;
  config.playback.duck.enabled = true;
  const view = await mountSettings();
  vi.useFakeTimers();

  await fireEvent.click(view.container.querySelector("#playback-streaming")!);
  await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
  expect(saved).toHaveLength(0);
  expect(saveBar.visible).toBe(true);

  await fireEvent.click(view.container.querySelector("#experimental-enabled")!);
  expect(saveBar.visible).toBe(false);
  await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS);
  expect(saved).toHaveLength(1);
  expect(saved[0].playback.streaming_enabled).toBe(false);
  expect(saved[0].general.experimental_enabled).toBe(true);
  expect(saved[0].history.enabled).toBe(true);
  expect(saved[0].post_process.enabled).toBe(true);
  expect(saved[0].playback.duck.enabled).toBe(true);
});

it("activates the short final section at the bottom of the layout scroll container", async () => {
  const view = await mountSettings();
  const scroller = view.getByRole("main");
  scroller.style.overflowY = "auto";
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: 800 }
  });
  await fireEvent.scroll(scroller);
  const misc = within(view.getByRole("navigation")).getByRole("button", { name: "Misc" });
  expect(misc.getAttribute("aria-current")).toBe("page");
  // SAFETY: only isIntersecting and target are read by this observer callback.
  intersect(
    [
      {
        isIntersecting: true,
        target: view.container.querySelector("#advanced")!
      } as IntersectionObserverEntry
    ],
    {} as IntersectionObserver
  );
  await tick();
  expect(misc.getAttribute("aria-current")).toBe("page");
});

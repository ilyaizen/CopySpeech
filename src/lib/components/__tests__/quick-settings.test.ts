// @vitest-environment jsdom

import { afterEach, beforeAll, expect, it } from "vite-plus/test";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { waitForI18nReady } from "#lib/i18n";
import { testConfig } from "#lib/test-fixtures/app-config";
import type { AppConfig, EffectId } from "#lib/types";
import QuickSettings from "../quick-settings.svelte";

function configWithProfile(enabled: boolean, activeEffect: EffectId): AppConfig {
  const config = testConfig();
  config.general.experimental_enabled = true;
  config.general.effects_enabled = true;
  config.tts.profiles = [
    {
      id: "default",
      name: "Default",
      description: null,
      engine: "kokoro",
      voice: "af_heart",
      voice_label: null,
      speed: 1,
      pitch: 1,
      effects: { enabled, active_effect: activeEffect },
      post_process: { enabled: false, active_template_id: null },
      engine_options: {}
    }
  ];
  return config;
}

beforeAll(async () => {
  await waitForI18nReady();
});

afterEach(() => cleanup());

it("gates quick hotkey and effects behind experimental and global switches", () => {
  const masterOff = testConfig();
  masterOff.general.experimental_enabled = false;
  masterOff.general.effects_enabled = true;
  masterOff.hotkey.enabled = true;
  const offView = render(QuickSettings, { config: masterOff });
  expect(offView.container.querySelector("#qs-hotkey")).toBeNull();
  expect(offView.container.querySelector("#qs-effects")).toBeNull();
  offView.unmount();

  const experimentalOn = testConfig();
  experimentalOn.general.experimental_enabled = true;
  experimentalOn.general.effects_enabled = false;
  experimentalOn.hotkey.enabled = true;
  const onView = render(QuickSettings, { config: experimentalOn });
  expect(onView.container.querySelector("#qs-hotkey")).not.toBeNull();
  expect(onView.container.querySelector("#qs-effects")).toBeNull();
});

it("keeps the selected effect across disabling and re-enabling the quick switch", async () => {
  const config = configWithProfile(true, "cyberpunk");
  const view = render(QuickSettings, { config });
  const toggle = view.container.querySelector("#qs-effects");
  if (!toggle) throw new Error("Missing effects switch");

  await fireEvent.click(toggle);
  expect(config.tts.profiles[0].effects).toEqual({ enabled: false, active_effect: "cyberpunk" });

  await fireEvent.click(toggle);
  expect(config.tts.profiles[0].effects).toEqual({ enabled: true, active_effect: "cyberpunk" });
});

it("defaults to walkie_talkie when re-enabling an effect with none active", async () => {
  const config = configWithProfile(false, "none");
  const view = render(QuickSettings, { config });
  const toggle = view.container.querySelector("#qs-effects");
  if (!toggle) throw new Error("Missing effects switch");
  await fireEvent.click(toggle);
  expect(config.tts.profiles[0].effects).toEqual({ enabled: true, active_effect: "walkie_talkie" });
});

it("updates active profile post_process.enabled when toggling the post-process switch", async () => {
  const config = configWithProfile(false, "none");
  config.post_process.enabled = true;
  const view = render(QuickSettings, { config });
  const toggle = view.container.querySelector("#qs-post-process");
  if (!toggle) throw new Error("Missing post-process switch");
  await fireEvent.click(toggle);
  expect(config.tts.profiles[0].post_process.enabled).toBe(true);
});

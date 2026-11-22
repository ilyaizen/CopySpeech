// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { waitForI18nReady } from "#lib/i18n";
import ProfileManager from "../profile-manager.svelte";
import { testConfig } from "#lib/test-fixtures/app-config";
import type { AppConfig, EngineCatalogEntry, VoiceCatalogEntry } from "#lib/types";

function voice(id: string, label: string): VoiceCatalogEntry {
  return {
    id,
    label,
    language: null,
    description: null,
    gender: null,
    preview_url: null,
    tags: []
  };
}

function entry(engine: string, voices: VoiceCatalogEntry[], refresh = false): EngineCatalogEntry {
  return {
    engine,
    label: engine,
    description: "",
    docs_url: "",
    supports_voice_refresh: refresh,
    supports_pitch: false,
    supports_captions: true,
    supports_bracket_emotes: false,
    options: [],
    voices
  };
}

const VOICE_CATALOG: EngineCatalogEntry[] = [
  entry("kokoro", [voice("af_heart", "Heart"), voice("am_adam", "Adam")]),
  entry("elevenlabs", [voice("premade-1", "Rachel"), voice("premade-2", "Adam")], true)
];

const OPENAI_CATALOG: EngineCatalogEntry[] = [
  {
    engine: "openai",
    label: "OpenAI",
    description: "Cloud TTS",
    docs_url: "https://platform.openai.com/docs/guides/text-to-speech",
    supports_voice_refresh: false,
    supports_pitch: false,
    supports_captions: true,
    supports_bracket_emotes: false,
    options: [
      {
        key: "model",
        label: "Model",
        kind: "select",
        help: "Speech model.",
        default_value: "tts-1",
        choices: ["tts-1", "gpt-4o-mini-tts"]
      },
      {
        key: "cuda",
        label: "GPU acceleration",
        kind: "boolean",
        help: "Run on GPU.",
        default_value: false
      },
      {
        key: "response_format",
        label: "Response Format",
        kind: "select",
        help: "Audio container.",
        default_value: "mp3",
        choices: ["mp3", "wav"]
      },
      {
        key: "quality",
        label: "Quality",
        kind: "select",
        help: "Numeric choices.",
        default_value: 0.5,
        choices: ["0", "0.5", "1"]
      },
      { key: "speed", label: "Speed", kind: "number", help: "Speech pace.", default_value: 1.0 },
      {
        key: "instructions",
        label: "Instructions",
        kind: "text",
        help: "Voice style.",
        default_value: ""
      }
    ],
    voices: []
  }
];

interface CachedVoiceStore {
  [engine: string]: { fetched_at_ms: number; voices: VoiceCatalogEntry[] };
}

let activeCatalog: EngineCatalogEntry[] = [];
let cachedVoices: CachedVoiceStore = {};
let refreshError: string | null = null;
const calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { engine?: string }) => {
    calls.push(cmd);
    if (cmd === "list_tts_engines") return activeCatalog;
    if (cmd === "get_cached_voices") return cachedVoices;
    if (cmd === "list_tts_voices") {
      if (refreshError) throw refreshError;
      return activeCatalog.find((e) => e.engine === args?.engine)?.voices ?? [];
    }
    if (cmd === "has_engine_credentials") return true;
    return undefined;
  })
}));

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}));

function configWith(
  engine: "kokoro" | "elevenlabs" | "openai",
  voiceId: string,
  label: string | null
): AppConfig {
  const config = testConfig();
  config.tts.active_profile_id = "p1";
  config.tts.profiles = [
    {
      id: "p1",
      name: "Reader",
      description: null,
      engine,
      voice: voiceId,
      voice_label: label,
      speed: 1.0,
      pitch: 1.0,
      effects: { enabled: false, active_effect: "none" },
      post_process: { enabled: false, active_template_id: null },
      engine_options: {}
    }
  ];
  return config;
}

beforeAll(async () => {
  await waitForI18nReady();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  activeCatalog = [];
  cachedVoices = {};
  refreshError = null;
  calls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("profile-manager defaults and effects", () => {
  it("creates new profiles with effects off even when experimental is enabled", async () => {
    const config = testConfig();
    config.general.experimental_enabled = true;
    config.tts.active_profile_id = "p1";
    config.tts.profiles = [
      {
        id: "p1",
        name: "Existing Profile",
        description: null,
        engine: "kokoro",
        voice: "af_heart",
        voice_label: "Heart",
        speed: 1.0,
        pitch: 1.0,
        effects: { enabled: true, active_effect: "cyberpunk" },
        post_process: { enabled: false, active_template_id: null },
        engine_options: {}
      }
    ];

    const view = render(ProfileManager, { localConfig: config });
    await fireEvent.click(view.getByRole("button", { name: /New Profile|New/i }));
    const presetItems = view.getAllByRole("menuitem");
    expect(presetItems.length).toBeGreaterThan(0);
    await fireEvent.click(presetItems[0]);

    expect(config.tts.profiles.length).toBe(2);
    expect(config.tts.profiles[1].effects).toEqual({ enabled: false, active_effect: "none" });
    expect(config.tts.profiles[0].effects).toEqual({ enabled: true, active_effect: "cyberpunk" });
  });

  it("shows none in effect select when profile effects is disabled with preserved effect", async () => {
    const config = testConfig();
    config.general.experimental_enabled = true;
    config.general.effects_enabled = true;
    config.tts.active_profile_id = "p1";
    config.tts.profiles = [
      {
        id: "p1",
        name: "Test Profile",
        description: null,
        engine: "kokoro",
        voice: "af_heart",
        voice_label: "Heart",
        speed: 1.0,
        pitch: 1.0,
        effects: { enabled: false, active_effect: "cyberpunk" },
        post_process: { enabled: false, active_template_id: null },
        engine_options: {}
      }
    ];

    const view = render(ProfileManager, { localConfig: config });
    const select = view.getByRole("combobox", { name: "Effect" });
    if (!(select instanceof HTMLSelectElement))
      throw new Error("Effect select is not a native select");
    expect(select.value).toBe("none");

    await fireEvent.change(select, { target: { value: "game_boy" } });
    expect(config.tts.profiles[0].effects).toEqual({ enabled: true, active_effect: "game_boy" });
  });
});

describe("profile voice selection", () => {
  beforeEach(() => {
    activeCatalog = VOICE_CATALOG;
  });

  it("fetches once uncached, keeps missing saved voices, and accepts manual raw ids", async () => {
    const config = configWith("elevenlabs", "my-clone-id", "My Clone");
    const view = render(ProfileManager, { localConfig: config });
    await waitFor(() => expect(calls).toContain("list_tts_voices"));
    expect(calls.filter((c) => c === "list_tts_voices")).toHaveLength(1);
    expect(view.getByRole("button", { name: /My Clone/ })).toBeTruthy();
    expect(config.tts.profiles[0].voice).toBe("my-clone-id");

    // SAFETY: the manual voice row is the page's only <input>; no select value is "my-clone-id".
    const manual = view.getByDisplayValue("my-clone-id") as HTMLInputElement;
    expect(manual.disabled).toBe(false);
    await fireEvent.change(manual, { target: { value: "custom-raw-id" } });
    expect(config.tts.profiles[0].voice).toBe("custom-raw-id");
  });

  it("does not carry one engine's voice id into another engine", async () => {
    const config = configWith("kokoro", "af_heart", "Heart");
    const view = render(ProfileManager, { localConfig: config });
    await waitFor(() => expect(view.getAllByRole("combobox").length).toBeGreaterThan(1));
    const engineSelect = view.getAllByRole("combobox")[1];
    await fireEvent.change(engineSelect, { target: { value: "elevenlabs" } });
    expect(config.tts.profiles[0].engine).toBe("elevenlabs");
    expect(config.tts.profiles[0].voice).toBe("premade-1");
    expect(config.tts.profiles[0].voice_label).toBe("Rachel");
  });

  it("never auto-refreshes cached lists and preserves them when refresh fails", async () => {
    const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    cachedVoices = {
      elevenlabs: { fetched_at_ms: yearAgo, voices: [voice("my-clone-id", "My Clone (cached)")] }
    };
    refreshError = "Failed to fetch voices: HTTP error: 401";
    const config = configWith("elevenlabs", "my-clone-id", "My Clone");
    const view = render(ProfileManager, { localConfig: config });
    const trigger = await waitFor(() => view.getByRole("button", { name: /My Clone \(cached\)/ }));
    expect(calls).not.toContain("list_tts_voices");

    await fireEvent.click(trigger);
    await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /^Refresh$/ })));
    await waitFor(() => expect(document.body.textContent).toContain("HTTP error: 401"));
    expect(view.getByRole("option", { name: /My Clone \(cached\)/ })).toBeTruthy();
    expect(config.tts.profiles[0].voice).toBe("my-clone-id");
  });

  it("shows a first-fetch failure in the sheet when it opens", async () => {
    refreshError = "Failed to fetch voices: HTTP error: 401";
    const config = configWith("elevenlabs", "premade-1", "Rachel");
    const view = render(ProfileManager, { localConfig: config });
    await waitFor(() => expect(calls).toContain("list_tts_voices"));
    await fireEvent.click(await waitFor(() => view.getByRole("button", { name: /Rachel/ })));
    await waitFor(() => expect(document.body.textContent).toContain("HTTP error: 401"));
  });
});

describe("profile-manager advanced engine options", () => {
  beforeEach(() => {
    activeCatalog = OPENAI_CATALOG;
  });

  function visibleSelects(
    view: ReturnType<typeof render<typeof ProfileManager>>
  ): HTMLSelectElement[] {
    return [...view.container.querySelectorAll("select")].filter(
      (el) => el.closest("[hidden]") === null
    );
  }

  it("keeps model/GPU visible, expands advanced options, and stores numeric choices as numbers", async () => {
    const config = configWith("openai", "", null);
    const view = render(ProfileManager, { localConfig: config });
    await waitFor(() => expect(view.getByRole("button", { name: "Advanced" })).toBeTruthy());

    const visibleBefore = visibleSelects(view);
    expect(visibleBefore).toHaveLength(4);
    const modelSelect = visibleBefore.find((s) =>
      [...s.options].some((o) => o.value === "gpt-4o-mini-tts")
    );
    expect(modelSelect?.value).toBe("tts-1");
    expect(visibleBefore.some((s) => [...s.options].some((o) => o.value === "false"))).toBe(true);

    const speedInput = view.container.querySelector('input[type="number"]');
    if (!(speedInput instanceof HTMLInputElement)) throw new Error("Speed input missing");
    expect(speedInput.closest("[hidden]")).not.toBeNull();
    const advanced = view.getByRole("button", { name: "Advanced" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");

    await fireEvent.click(advanced);
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(speedInput.closest("[hidden]")).toBeNull();
    expect(speedInput.value).toBe("1");
    expect(visibleSelects(view)).toHaveLength(6);

    const quality = visibleSelects(view).find((s) => [...s.options].some((o) => o.value === "0.5"));
    if (!quality) throw new Error("Quality select did not appear");
    await fireEvent.change(quality, { target: { value: "1" } });
    expect(config.tts.profiles[0].engine_options.quality).toBe(1);
  });
});

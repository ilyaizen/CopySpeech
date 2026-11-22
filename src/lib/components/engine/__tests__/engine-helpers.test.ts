import { describe, expect, it } from "vite-plus/test";
import { firstEnvKeyConflict } from "../env-keys";
import { isValidProfile, normalizeImportedProfile, type ParsedJson } from "../profile-validation";
import { choicesWithCurrent } from "../select-choices";
import type { VoiceProfile } from "#lib/types";

function baseValidProfile(): ParsedJson {
  return {
    id: "test-profile",
    name: "Test Profile",
    engine: "kokoro",
    voice: "af_heart",
    speed: 1.0,
    pitch: 1.0,
    effects: {
      enabled: false,
      active_effect: "none"
    }
  };
}

describe("profile-validation", () => {
  it("accepts valid legacy and post-process profile shapes", () => {
    expect(isValidProfile(baseValidProfile())).toBe(true);
    expect(
      isValidProfile({
        ...baseValidProfile(),
        post_process: { enabled: true, active_template_id: "concise" }
      })
    ).toBe(true);
    expect(
      isValidProfile({
        ...baseValidProfile(),
        post_process: { enabled: false, active_template_id: null }
      })
    ).toBe(true);
    expect(isValidProfile({ ...baseValidProfile(), post_process: { enabled: false } })).toBe(true);
  });

  it("rejects non-object roots, missing core fields, and unknown engine or effect ids", () => {
    for (const root of [null, undefined, "string", 123, []]) {
      expect(isValidProfile(root)).toBe(false);
    }
    for (const key of ["id", "engine", "effects"] as const) {
      const partial = baseValidProfile();
      delete partial[key];
      expect(isValidProfile(partial)).toBe(false);
    }
    expect(isValidProfile({ ...baseValidProfile(), engine: "unknown-engine" })).toBe(false);
    expect(
      isValidProfile({
        ...baseValidProfile(),
        effects: { enabled: true, active_effect: "laser-eyes" }
      })
    ).toBe(false);
  });

  it("rejects malformed post_process shapes and invalid field types", () => {
    for (const postProcess of ["enabled", true, 123, null, []]) {
      expect(isValidProfile({ ...baseValidProfile(), post_process: postProcess })).toBe(false);
    }
    for (const enabled of ["true", 1]) {
      expect(
        isValidProfile({
          ...baseValidProfile(),
          post_process: { enabled, active_template_id: null }
        })
      ).toBe(false);
    }
    for (const activeTemplateId of [123, {}, false]) {
      expect(
        isValidProfile({
          ...baseValidProfile(),
          post_process: { enabled: true, active_template_id: activeTemplateId }
        })
      ).toBe(false);
    }
  });

  it("normalizeImportedProfile supplies defaults and coerces blank or missing template ids to null", () => {
    const typedProfile: VoiceProfile = {
      id: "test-profile",
      name: "Test Profile",
      description: null,
      engine: "kokoro",
      voice: "af_heart",
      voice_label: null,
      speed: 1.0,
      pitch: 1.0,
      effects: { enabled: false, active_effect: "none" },
      post_process: { enabled: false, active_template_id: null },
      engine_options: {}
    };

    const legacy = JSON.parse(JSON.stringify(typedProfile));
    delete legacy.post_process;
    expect(isValidProfile(legacy)).toBe(true);
    expect(normalizeImportedProfile(legacy).post_process).toEqual({
      enabled: false,
      active_template_id: null
    });

    expect(
      normalizeImportedProfile({
        ...typedProfile,
        post_process: { enabled: true, active_template_id: "custom-1" }
      }).post_process
    ).toEqual({ enabled: true, active_template_id: "custom-1" });

    expect(
      normalizeImportedProfile({
        ...typedProfile,
        post_process: { enabled: true, active_template_id: "   " }
      }).post_process.active_template_id
    ).toBeNull();

    const undefinedId = JSON.parse(JSON.stringify(typedProfile));
    undefinedId.post_process = { enabled: true };
    expect(isValidProfile(undefinedId)).toBe(true);
    expect(normalizeImportedProfile(undefinedId).post_process.active_template_id).toBeNull();
  });
});

describe("firstEnvKeyConflict", () => {
  it("warns only when a trimmed non-empty key differs from the saved value", () => {
    expect(
      firstEnvKeyConflict("xai", "XAI_API_KEY", { api_key: "typed-key" }, { api_key: "" })
    ).toEqual({ engine: "xai", envVar: "XAI_API_KEY" });
    expect(
      firstEnvKeyConflict(
        "xai",
        "XAI_API_KEY",
        { api_key: "persisted-key" },
        { api_key: "persisted-key" }
      )
    ).toBeNull();
    expect(
      firstEnvKeyConflict("xai", "XAI_API_KEY", { api_key: "   " }, { api_key: "" })
    ).toBeNull();
    expect(firstEnvKeyConflict("xai", "XAI_API_KEY", undefined, { api_key: "" })).toBeNull();
    expect(
      firstEnvKeyConflict("fish", "FISH_API_KEY", { api_key: "key1 " }, { api_key: "key1" })
    ).toBeNull();
  });
});

describe("choicesWithCurrent", () => {
  it("preserves listed or blank values and appends missing saved choices", () => {
    const choices = ["eleven_v4", "eleven_v3"];
    expect(choicesWithCurrent(choices, "eleven_v3")).toEqual(["eleven_v4", "eleven_v3"]);
    expect(choicesWithCurrent(choices, "eleven_turbo_v2_5")).toEqual([
      "eleven_v4",
      "eleven_v3",
      "eleven_turbo_v2_5"
    ]);
    expect(choicesWithCurrent(choices, "")).toEqual(["eleven_v4", "eleven_v3"]);
    expect(choicesWithCurrent(choices, null)).toEqual(["eleven_v4", "eleven_v3"]);
    expect(choicesWithCurrent(choices, undefined)).toEqual(["eleven_v4", "eleven_v3"]);
  });
});

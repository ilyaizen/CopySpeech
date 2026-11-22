import { describe, expect, it } from "vite-plus/test";
import {
  activeTemplate,
  clearDeletedTemplateFromProfiles,
  createCustomTemplate,
  fallbackTemplateId,
  resolveProfileTemplate,
  switchDisabledFor
} from "../post-process-templates";
import type { PostProcessConfig, PostProcessTemplate, VoiceProfile } from "#lib/types";

function template(id: string, templateClass: PostProcessTemplate["class"]): PostProcessTemplate {
  return { id, name: id, class: templateClass, prompt: `${id} ${"${output}"}` };
}

function config(templates: PostProcessTemplate[], activeId: string): PostProcessConfig {
  return {
    enabled: false,
    provider_id: "groq",
    providers: [],
    templates,
    active_template_id: activeId,
    min_chars: 0,
    require_request_flag: false,
    timeout_secs: 5
  } satisfies PostProcessConfig;
}

describe("post-process-templates", () => {
  it("activeTemplate returns match, falls back to first on dangling id, or undefined if empty", () => {
    const templates = [template("dramatize", "preserve"), template("concise", "rewrite")];
    expect(activeTemplate(config(templates, "concise"))?.id).toBe("concise");
    expect(activeTemplate(config(templates, "deleted"))?.id).toBe("dramatize");
    expect(activeTemplate(config([], "dramatize"))).toBeUndefined();
  });

  it("switchDisabledFor disables preserve templates only when emote tags are unsupported", () => {
    const dramatize = template("dramatize", "preserve");
    const concise = template("concise", "rewrite");
    expect(switchDisabledFor(dramatize, false)).toBe(true);
    expect(switchDisabledFor(dramatize, true)).toBe(false);
    expect(switchDisabledFor(concise, false)).toBe(false);
    expect(switchDisabledFor(undefined, false)).toBe(false);
  });

  it("createCustomTemplate defaults to rewrite draft with unique non-builtin ids", () => {
    const first = createCustomTemplate([]);
    const second = createCustomTemplate([first]);
    expect(first.class).toBe("rewrite");
    expect(first.prompt).toBe("");
    expect(first.name).toBe("New template");
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe("dramatize");
    expect(first.id).not.toBe("concise");
  });

  it("fallbackTemplateId prefers dramatize, then first entry, then empty", () => {
    const templates = [template("dramatize", "preserve"), template("concise", "rewrite")];
    expect(fallbackTemplateId(templates)).toBe("dramatize");
    expect(fallbackTemplateId([template("concise", "rewrite")])).toBe("concise");
    expect(fallbackTemplateId([])).toBe("");
  });

  it("resolveProfileTemplate respects override, falls back to global active, then first", () => {
    const templates = [
      template("dramatize", "preserve"),
      template("concise", "rewrite"),
      template("custom-1", "rewrite")
    ];
    const cfg = config(templates, "concise");
    expect(resolveProfileTemplate(cfg, "custom-1")?.id).toBe("custom-1");
    expect(resolveProfileTemplate(cfg, null)?.id).toBe("concise");
    expect(resolveProfileTemplate(cfg, "")?.id).toBe("concise");
    expect(resolveProfileTemplate(cfg, undefined)?.id).toBe("concise");
    expect(resolveProfileTemplate(cfg, "nonexistent-template")?.id).toBe("concise");

    const danglingGlobalCfg = config(templates, "dangling-global");
    expect(resolveProfileTemplate(danglingGlobalCfg, "nonexistent-profile-tmpl")?.id).toBe(
      "dramatize"
    );
  });

  it("clearDeletedTemplateFromProfiles resets active_template_id to null only for deleted id", () => {
    const profiles: VoiceProfile[] = [
      {
        id: "p1",
        name: "P1",
        description: null,
        voice_label: null,
        engine_options: {},
        engine: "kokoro",
        voice: "v1",
        speed: 1,
        pitch: 1,
        effects: { enabled: false, active_effect: "none" },
        post_process: { enabled: true, active_template_id: "victim-id" }
      },
      {
        id: "p2",
        name: "P2",
        description: null,
        voice_label: null,
        engine_options: {},
        engine: "kokoro",
        voice: "v2",
        speed: 1,
        pitch: 1,
        effects: { enabled: false, active_effect: "none" },
        post_process: { enabled: true, active_template_id: "keep-id" }
      },
      {
        id: "p3",
        name: "P3",
        description: null,
        voice_label: null,
        engine_options: {},
        engine: "kokoro",
        voice: "v3",
        speed: 1,
        pitch: 1,
        effects: { enabled: false, active_effect: "none" },
        post_process: { enabled: false, active_template_id: null }
      }
    ];

    clearDeletedTemplateFromProfiles(profiles, "victim-id");

    expect(profiles[0].post_process?.active_template_id).toBeNull();
    expect(profiles[1].post_process?.active_template_id).toBe("keep-id");
    expect(profiles[2].post_process?.active_template_id).toBeNull();
  });
});

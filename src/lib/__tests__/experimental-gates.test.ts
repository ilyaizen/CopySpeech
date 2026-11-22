import { describe, expect, test } from "vite-plus/test";
import { effectiveEffect, type EffectGateConfig } from "#lib/effects-gate";
import {
  isHistoryEffective,
  isHudEffective,
  isPostProcessEffective
} from "#lib/experimental-gates";

describe("experimental master switch", () => {
  test("gates history, post_process, and hud behind experimental_enabled", () => {
    const cases = [
      [
        "history",
        (exp: boolean | undefined, enabled: boolean) =>
          isHistoryEffective({
            general: exp === undefined ? {} : { experimental_enabled: exp },
            history: { enabled }
          }),
        isHistoryEffective
      ],
      [
        "post_process",
        (exp: boolean | undefined, enabled: boolean) =>
          isPostProcessEffective({
            general: exp === undefined ? {} : { experimental_enabled: exp },
            post_process: { enabled }
          }),
        isPostProcessEffective
      ],
      [
        "hud",
        (exp: boolean | undefined, enabled: boolean) =>
          isHudEffective({
            general: exp === undefined ? {} : { experimental_enabled: exp },
            hud: { enabled }
          }),
        isHudEffective
      ]
    ] as const;

    for (const [name, check, rawCheck] of cases) {
      expect(check(true, true), `${name} both true`).toBe(true);
      expect(check(false, true), `${name} exp false`).toBe(false);
      expect(check(true, false), `${name} feature false`).toBe(false);
      expect(check(undefined, true), `${name} legacy exp undefined`).toBe(false);
      expect(rawCheck(null), `${name} null`).toBe(false);
      expect(rawCheck(undefined), `${name} undefined`).toBe(false);
    }
  });
});

describe("effectiveEffect", () => {
  function effectConfig(experimental: boolean | undefined, enabled: boolean): EffectGateConfig {
    return {
      general: { experimental_enabled: experimental, effects_enabled: true },
      tts: {
        active_profile_id: "p1",
        profiles: [{ id: "p1", effects: { enabled, active_effect: "walkie_talkie" } }]
      }
    };
  }

  test("gates profile effects behind global switches, experimental flag, and active profile", () => {
    expect(effectiveEffect(effectConfig(true, true))).toBe("walkie_talkie");
    expect(effectiveEffect(effectConfig(false, true))).toBe("none");
    expect(effectiveEffect(effectConfig(undefined, true))).toBe("none");
    expect(effectiveEffect(effectConfig(true, false))).toBe("none");

    const globalOff = effectConfig(true, true);
    globalOff.general.effects_enabled = false;
    expect(effectiveEffect(globalOff)).toBe("none");

    const missingProfile = effectConfig(true, true);
    missingProfile.tts.active_profile_id = "gone";
    expect(effectiveEffect(missingProfile)).toBe("none");
  });
});

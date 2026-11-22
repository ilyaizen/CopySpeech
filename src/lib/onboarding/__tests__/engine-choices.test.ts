import { expect, it } from "vite-plus/test";
import { ENGINE_CHOICES, recommendedEngineId, visibleEngineChoices } from "../engine-choices.js";

it("filters visible engines per platform and matches the recommended default", () => {
  for (const platform of ["windows", "macos", "linux"]) {
    const visible = visibleEngineChoices(platform);
    const ids = visible.map((choice) => choice.id);
    expect(ids.includes("kale"), platform).toBe(platform === "windows");
    expect(ids).toContain(recommendedEngineId(platform));
  }
  for (const choice of ENGINE_CHOICES) {
    if (choice.installer !== null) {
      expect(choice.installVoices.length, choice.id).toBeGreaterThan(0);
    }
  }
});

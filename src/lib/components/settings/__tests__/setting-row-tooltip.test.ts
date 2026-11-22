import { expect, test } from "vite-plus/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Every SettingRow in Settings puts its description in `tooltip=`, never in a <p>
// below the row. Fail loudly if the settings directory yields no components.
const SETTINGS_DIR = join(import.meta.dirname, "..");
const SETTINGS_PAGE = join(import.meta.dirname, "../..", "settings-page.svelte");

function settingComponentPaths(): string[] {
  const paths = readdirSync(SETTINGS_DIR)
    .filter((name) => name.endsWith(".svelte"))
    .map((name) => join(SETTINGS_DIR, name));
  if (paths.length === 0) {
    throw new Error(
      `No .svelte components found in ${SETTINGS_DIR}; the tooltip contract would test nothing`
    );
  }
  return [...paths, SETTINGS_PAGE];
}

function settingRowsWithoutTooltip(source: string): string[] {
  const rows: string[] = [];
  for (const match of source.matchAll(/<SettingRow\b/g)) {
    const start = match.index;
    // Scan to the tag's closing '>' while ignoring '>' inside {...} expressions.
    let depth = 0;
    let index = start;
    while (index < source.length) {
      const ch = source[index];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ">" && depth === 0) break;
      index += 1;
    }
    rows.push(source.slice(start, index + 1));
  }
  return rows.filter((row) => !row.includes("tooltip="));
}

test("every SettingRow across settings components carries a tooltip", () => {
  const missing: Array<{ file: string; row: string }> = [];
  for (const path of settingComponentPaths()) {
    const source = readFileSync(path, "utf-8");
    const file = path.split(/[\\/]/).pop() ?? path;
    for (const row of settingRowsWithoutTooltip(source)) {
      missing.push({ file, row });
    }
  }
  expect(missing).toEqual([]);
});

import { expect, it } from "vite-plus/test";
import ar from "#lib/locales/ar.json";
import de from "#lib/locales/de.json";
import en from "#lib/locales/en.json";
import es from "#lib/locales/es.json";
import fr from "#lib/locales/fr.json";
import he from "#lib/locales/he.json";
import hi from "#lib/locales/hi.json";
import ru from "#lib/locales/ru.json";
import zh from "#lib/locales/zh.json";
import { ENGINE_CHOICES } from "#lib/onboarding/engine-choices";
import { isRtlLocale, isSupportedLocale, resolveLocale } from "../utils";

type Catalog = { [key: string]: Catalog | string };

// Dot-notation key paths, matching scripts/generate-i18n-types.js
function flattenKeys(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Object.prototype.toString.call(value) !== "[object Object]") return [path];
    // SAFETY: a value that is not a string leaf is a nested object, so it is a Catalog.
    return flattenKeys(value as Catalog, path);
  });
}

function getKey(catalog: Catalog, path: string): string {
  let node: Catalog | string = catalog;
  for (const part of path.split(".")) {
    if (Object.prototype.toString.call(node) !== "[object Object]") {
      throw new Error(`path ${path} descends past a string leaf`);
    }
    // SAFETY: a node that is not a string leaf is a nested object, so it is a Catalog.
    const next: Catalog | string | undefined = (node as Catalog)[part];
    if (next === undefined) throw new Error(`missing key ${path}`);
    node = next;
  }
  if (Object.prototype.toString.call(node) !== "[object String]") {
    throw new Error(`key ${path} is not a string leaf`);
  }
  // SAFETY: a final node that is not an object is the string leaf the path names.
  return node as string;
}

it("validates supported codes and RTL locales", () => {
  expect(isSupportedLocale("en")).toBe(true);
  expect(isSupportedLocale("es")).toBe(true);
  expect(isSupportedLocale("he")).toBe(true);
  expect(isSupportedLocale("")).toBe(false);
  expect(isSupportedLocale("xx")).toBe(false);

  expect(isRtlLocale("he")).toBe(true);
  expect(isRtlLocale("ar")).toBe(true);
  expect(isRtlLocale("en")).toBe(false);
  expect(isRtlLocale("es")).toBe(false);
});

it("resolves regional system tags and preserves explicit language overrides", () => {
  expect(resolveLocale("", "he-IL")).toBe("he");
  expect(resolveLocale("", "ar-EG")).toBe("ar");
  expect(resolveLocale("", "zh-Hant-TW")).toBe("zh");
  expect(resolveLocale("", "DE-de")).toBe("de");
  expect(resolveLocale("", "fr-FR")).toBe("fr");
  expect(resolveLocale("", "es-MX")).toBe("es");
  expect(resolveLocale("", "hi-IN")).toBe("hi");
  expect(resolveLocale("", "ru-RU")).toBe("ru");
  expect(resolveLocale("", "en-US")).toBe("en");
  expect(resolveLocale("", "ja-JP")).toBe("en");
  expect(resolveLocale("", "")).toBe("en");

  expect(resolveLocale("en", "he-IL")).toBe("en");
  expect(resolveLocale("ar", "en-US")).toBe("ar");
  expect(resolveLocale("unsupported", "he-IL")).toBe("en");
});

it("keeps all nine locale catalogs free of orphan keys and resolves required UI copy", () => {
  const catalogs = { en, es, he, ar, de, fr, hi, ru, zh } satisfies Record<string, Catalog>;
  const englishKeys = new Set(flattenKeys(en));
  for (const [code, catalog] of Object.entries(catalogs)) {
    if (code !== "en") {
      const orphans = flattenKeys(catalog).filter((key) => !englishKeys.has(key));
      expect(orphans, `${code} orphan keys`).toEqual([]);
    }
    const aboutMadeWith = getKey(catalog, "settings.about.madeWith");
    expect(aboutMadeWith, `${code} madeWith`).toBeTruthy();
    expect(aboutMadeWith.split("{heart}"), `${code} heart placeholder`).toHaveLength(2);
    expect(getKey(catalog, "settings.about.buyMeCoffee"), `${code} buyMeCoffee`).toBeTruthy();
    for (const choice of ENGINE_CHOICES) {
      expect(getKey(catalog, choice.detailKey).length, `${code} ${choice.id}`).toBeGreaterThan(0);
    }
  }
});

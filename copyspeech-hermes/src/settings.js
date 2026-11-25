import { BUILT_IN_KEY, DEFAULTS, EXCERPT_MAX, EXCERPT_MIN, MODES } from "./constants.js";

export function clampCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return EXCERPT_MIN;
  return Math.min(EXCERPT_MAX, Math.max(EXCERPT_MIN, number));
}

// Keep a boolean setting, or fall back to its default.
function boolOr(value, fallback) {
  return value === true || value === false ? value : fallback;
}

export function normalizeSettings(raw) {
  const source = raw ?? {};
  return {
    autoRead: boolOr(source.autoRead, DEFAULTS.autoRead),
    excerpt: boolOr(source.excerpt, DEFAULTS.excerpt),
    excerptMode: MODES.includes(source.excerptMode) ? source.excerptMode : DEFAULTS.excerptMode,
    excerptTop: clampCount(source.excerptTop ?? DEFAULTS.excerptTop),
    excerptBottom: clampCount(source.excerptBottom ?? DEFAULTS.excerptBottom),
    captions: boolOr(source.captions, DEFAULTS.captions),
    glide: boolOr(source.glide, DEFAULTS.glide),
    follow: boolOr(source.follow, DEFAULTS.follow),
    messageButtons: boolOr(source.messageButtons, DEFAULTS.messageButtons),
    selectionRead: boolOr(source.selectionRead, DEFAULTS.selectionRead),
    skipMarkdownSections: boolOr(source.skipMarkdownSections, DEFAULTS.skipMarkdownSections)
  };
}

export function builtInAutoSpeakOn() {
  try {
    return localStorage.getItem(BUILT_IN_KEY) === "true";
  } catch {
    return false;
  }
}

export function readSettings(storage) {
  return normalizeSettings(storage.get("settings", DEFAULTS));
}

export function saveSettings(storage, settings, patch) {
  const next = normalizeSettings({ ...readSettings(storage), ...patch });
  storage.set("settings", next);
  settings.set(next);
  return next;
}

// Draft edits whose value differs from the saved value. Only these are written on Save.
export function pendingEdits(saved, draft) {
  const pending = {};
  for (const key of Object.keys(draft)) {
    if (draft[key] !== saved[key]) pending[key] = draft[key];
  }
  return pending;
}

// Form values: unsaved edits win, every other field follows the saved settings.
export function draftView(saved, draft) {
  return { ...saved, ...draft };
}

// One edit on top of the draft. A value equal to the saved value is not an edit, so it is dropped.
export function applyEdit(saved, draft, patch) {
  return pendingEdits(saved, { ...draft, ...patch });
}

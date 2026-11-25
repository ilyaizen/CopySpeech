export const ID = "copyspeech-hermes";
// ctx.storage keys live under hermes.plugin.<id>. (localStorage), so this is the key for "settings".
export const SETTINGS_KEY = "hermes.plugin." + ID + ".settings";
export const CONTROL_URL = "http://127.0.0.1:43117";
export const SPEAK_URL = CONTROL_URL + "/speak";
export const HEALTH_URL = CONTROL_URL + "/health";
export const STATUS_URL = CONTROL_URL + "/status";
export const BUILT_IN_KEY = "hermes.desktop.autoSpeakReplies";
export const MAX_CLAIMS = 50;
export const EXCERPT_MIN = 1;
export const EXCERPT_MAX = 20;
export const MODES = ["top", "bottom", "both"];
export const DEFAULTS = {
  autoRead: false,
  excerpt: true,
  excerptMode: "both",
  excerptTop: 2,
  excerptBottom: 2,
  captions: true,
  glide: false,
  follow: false,
  messageButtons: true,
  selectionRead: true,
  skipMarkdownSections: false
};
export const CAPTION_NAME = "copyspeech-word";
export const CAPTION_STYLE_ID = "copyspeech-hermes-captions";
export const CAPTION_POLL_MS = 120;
export const CAPTION_SILENCE_MS = 60000;
// Follow keeps the spoken word between these fractions of the reply's scrollport.
// Outside the band, its line moves to the anchor. Manual input pauses follow.
export const FOLLOW_BAND_TOP = 0.15;
export const FOLLOW_BAND_BOTTOM = 0.82;
export const FOLLOW_ANCHOR = 0.34;
export const FOLLOW_INTERVAL_MS = 400;
export const FOLLOW_PAUSE_MS = 5000;
export const FOLLOW_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
export const ALIGN_WINDOW = 24;
export const RUN_NEEDED = 3;
export const REASONING_SELECTOR =
  '[data-slot="aui_reasoning-text"], [data-slot="aui_thinking-disclosure"], [data-slot="aui_thinking-body"]';
// Glide pill: the glide duration, the per-frame cap, the padding around a word, and the look.
export const GLIDE_MS = 120;
export const GLIDE_FRAME_CAP_MS = 40;
export const PILL_PAD_X = 4;
export const PILL_PAD_Y = 2;
export const PILL_RADIUS_PX = 4;
export const PILL_Z_INDEX = 2147483646;
// Any overflow other than `visible` clips a box's content.
export const CLIP_OVERFLOW = ["auto", "scroll", "hidden", "clip"];

// ---- Playback controls: one shared reading, three ways to start it ----
// The message play button, the selection read, and auto-read all register the
// same request here. The bar and the buttons observe the record and repaint.
export const SEEK_STEP_MS = 5000;
// An optimistic pause survives this long before a poll may override it, so a
// poll that left before the app applied the command cannot flicker the glyph.
export const PAUSE_RECONCILE_MS = 350;
export const MESSAGE_ROOT_SELECTOR =
  '[data-slot="aui_assistant-message-root"][data-role="assistant"]';
export const MESSAGE_BODY_SELECTOR = ".aui-md";
export const MESSAGE_ACTIONS_SELECTOR = ".aui-message-actions-desktop";
export const PLAY_BUTTON_FLAG = "data-copyspeech-play";
export const UI_STYLE_ID = "copyspeech-hermes-ui";

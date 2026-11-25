import { CAPTION_NAME, CAPTION_STYLE_ID, UI_STYLE_ID } from "../constants.js";

export function installCaptionStyle() {
  const old = document.getElementById(CAPTION_STYLE_ID);
  if (old !== null) old.remove();
  const style = document.createElement("style");
  style.id = CAPTION_STYLE_ID;
  style.textContent =
    "::highlight(" +
    CAPTION_NAME +
    ") { background-color: color-mix(in oklab, var(--ui-accent) 30%, transparent); }";
  document.head.appendChild(style);
  return style;
}

const UI_STYLE = [
  /* The message play button sits in the host's hover action row, beside Copy
     and the built-in Read aloud. The row is transparent until the message is
     hovered; the button inherits that, so it appears with its neighbors. */
  ".csh-msg-play{width:28px;height:28px;border:none;border-radius:6px;background:transparent;padding:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ui-text-tertiary)}",
  "@media (hover:hover){.csh-msg-play:hover{background:color-mix(in oklab, var(--ui-text-tertiary) 12%, transparent);color:var(--ui-text-secondary)}}",
  ".csh-msg-play:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}",
  ".csh-msg-play svg{width:15px;height:15px;display:block}",
  ".csh-tooltip{position:fixed;z-index:2147483002;pointer-events:none;max-width:min(24rem, calc(100vw - 24px));border-radius:4px;background:var(--foreground);color:var(--background);padding:4px 8px;font-family:inherit;font-size:0.6875rem;font-weight:500;line-height:1.4;overflow-wrap:anywhere;white-space:normal}",
  /* The playback bar sits in the composer's top slot, left-aligned above the
     input. The composer ring draws its outline, so the bar has no border. */
  ".csh-bar{display:inline-flex;align-items:center;align-self:flex-start;gap:2px;padding:0 2px}",
  ".csh-bar-btn{width:26px;height:26px;border:none;border-radius:6px;background:transparent;padding:5px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ui-text-secondary)}",
  "@media (hover:hover){.csh-bar-btn:hover{background:color-mix(in oklab, var(--ui-text-secondary) 12%, transparent)}}",
  ".csh-bar-btn:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px}",
  ".csh-bar-btn svg{width:15px;height:15px;display:block}",
  ".csh-bar-stop{color:var(--ui-text-primary, var(--ui-text-secondary))}",
  /* The selection pill: a small floating Read aloud above the selection. */
  ".csh-pill{position:fixed;z-index:2147483001}",
  ".csh-pill-btn{border:none;border-radius:999px;padding:5px 12px;background:var(--ui-accent);color:var(--ui-accent-foreground, #fff);font:inherit;font-size:12px;line-height:16px;cursor:pointer;box-shadow:0 4px 14px rgb(0 0 0 / 22%)}",
  "@media (hover:hover){.csh-pill-btn:hover{filter:brightness(1.08)}}",
  ".csh-pill-btn:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}"
].join("\n");

export function installUiStyle() {
  const old = document.getElementById(UI_STYLE_ID);
  if (old !== null) old.remove();
  const style = document.createElement("style");
  style.id = UI_STYLE_ID;
  style.textContent = UI_STYLE;
  document.head.appendChild(style);
  return style;
}

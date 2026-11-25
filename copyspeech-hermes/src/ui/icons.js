const SVG_NS = "http://www.w3.org/2000/svg";

// Icons draw in currentColor, so every surface follows the app theme. The
// speaker is the outlined app-logo mark; the controls are filled, one family.
export const ICON_SPEAKER = {
  viewBox: "14.86 14.717 48.611 48.611",
  stroked: true,
  paths: [
    "m37.35 20.74c-0.74-0.04-1.46 0.21-2.02 0.71l-7.68 7.13c-0.24 0.23-0.56 0.37-0.9 0.39l-5.58 0.21c-2.55 0.1-4.51 2.23-4.51 5v7.99c0 2.81 2.1 4.95 4.74 5.09l5.3 0.28c0.28 0.02 0.54 0.15 0.74 0.35l7.94 8.12c0.71 0.71 1.67 1.04 2.55 1.02 1.52-0.04 2.65-1.2 2.65-2.76v-30.18c0-1.84-1.65-3.27-3.23-3.35z",
    "M48.17 21.93A19.44 19.44 0 0 1 48.17 56.13",
    "M45.06 31.13A9.43 9.43 0 0 1 45.06 46.87"
  ]
};
export const ICON_PLAY = { viewBox: "0 0 16 16", paths: ["M5.8 3.5 12.2 8 5.8 12.5Z"] };
export const ICON_PAUSE = { viewBox: "0 0 16 16", paths: ["M4.6 3h2.5v10H4.6zM8.9 3h2.5v10H8.9z"] };
export const ICON_STOP = { viewBox: "0 0 16 16", paths: ["M3.8 3.8h8.4v8.4H3.8z"] };
// The message button's stop glyph: an outlined square in the speaker's own
// viewBox and stroke, so the two glyphs share weight and size.
export const ICON_STOP_MESSAGE = {
  viewBox: "14.86 14.717 48.611 48.611",
  stroked: true,
  paths: ["M23 29h20v20H23z"]
};
export const ICON_BACK = {
  viewBox: "0 0 24 24",
  paths: ["M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"]
};
export const ICON_FORWARD = {
  viewBox: "0 0 24 24",
  paths: ["M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"]
};
export const ICON_CHAT = {
  viewBox: "0 0 16 16",
  paths: [
    "M3.6 3.1H12.4A1.9 1.9 0 0 1 14.3 5V9A1.9 1.9 0 0 1 12.4 10.9H7.6L4.9 13.3V10.9H3.6A1.9 1.9 0 0 1 1.7 9V5A1.9 1.9 0 0 1 3.6 3.1Z"
  ]
};

export function svgGlyph(icon, size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", icon.viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const stroke = icon.stroked === true ? String(3.3 * (17 / size)) : null;
  for (const d of icon.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    if (stroke !== null) {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", stroke);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    } else {
      path.setAttribute("fill", "currentColor");
    }
    svg.appendChild(path);
  }
  return svg;
}

import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Reading } from "../types";
import { ICON_SVG } from "./icon";
import { blockLines, blocks, fenceAfter, fenceSpans, inlineSpans } from "./markdown";
import type { Block, Line } from "./markdown";

// Port of copyspeech-hermes to Claude Code. CopySpeech's control server does the
// speaking; this mod draws the play button, the captions pane, and the Read aloud
// menu row. The engine draws each reply's own Markdown untouched.
const CONTROL = "http://127.0.0.1:43117";
const POLL_MS = 120;
// The plugin's name in its manifest; its `/config` keys start with it.
const PLUGIN_NAME = "copyspeech";
const IDLE_STOP_MS = 2000;
// No playback this long ends a reading, whatever the status reports.
const SILENT_STOP_MS = 60000;
const ALIGN_WINDOW = 24;
const RUN_NEEDED = 3;
const EXCERPT_MIN = 1;
const EXCERPT_MAX = 20;
// The spoken word's chip: reverse video, the text color behind the word and the
// inverse text over it. A background moves no glyph, so words after the chip never move.
const CHIP = { backgroundColor: "text", color: "inverseText" } as const;
// The captions pane: the reading's replies drawn from their Markdown, with the chip on the spoken word.
const PANE = "captions";
// Theme color for link text, so the pane follows the person's theme.
const LINK = "suggestion";
const EXCERPT_MODES = ["both", "top", "bottom"];

// Rows and the band read `reading`, which changes only at start, pause, resume and
// stop. Only the captions pane reads `spoken`, so a word redraws the pane alone.
const reading = atom({ plugin: "copyspeech", key: "reading" } as const, null);
const spoken = atom({ plugin: "copyspeech", key: "spoken" } as const, null);
// The rows the captions pane shows: the latest reading's replies. A new reading replaces them.
// The key keeps its old name: a pane hook from before a reload still reads it until it is replaced.
type ShownRow = { row: string; md: string };
const noRows: ShownRow[] = [];
const history = atom({ plugin: "copyspeech", key: "history" } as const, noRows);
// Whether the captions pane's settings are expanded.
const settingsOpen = atom({ plugin: "copyspeech", key: "settingsOpen" } as const, false);
type SettingValue = boolean | number | string;
export type Settings = {
  autoRead: boolean;
  skipSections: boolean;
  excerpt: boolean;
  excerptMode: string;
  excerptTop: number;
  excerptBottom: number;
  captions: boolean;
};
// A setting write the engine took: `to` replaces the loaded value `from`. It holds only while the
// plugin still runs with `from`; a reload with any other value retires it.
export type Override = { from: SettingValue; to: SettingValue };
const noOverrides: Record<string, Override> = {};
const settingOverrides = atom(
  { plugin: "copyspeech", key: "settingOverrides" } as const,
  noOverrides
);

// The settings in force: the loaded ones, with each override that still holds.
export function applyOverrides(loaded: Settings, overrides: Record<string, Override>): Settings {
  const now = new Map(Object.entries(loaded));
  const out = { ...loaded };
  for (const [field, o] of Object.entries(overrides)) {
    // An entry from an older build is a bare value with no `from`, so it never holds.
    // recordOverride writes each override with its own field's type.
    if (now.has(field) && now.get(field) === o?.from) Object.assign(out, { [field]: o.to });
  }
  return out;
}

async function settingsNow($: EngineInterface, loaded: Settings): Promise<Settings> {
  return applyOverrides(loaded, await read($, settingOverrides));
}

async function recordOverride(
  $: EngineInterface,
  field: string,
  from: SettingValue,
  to: SettingValue
) {
  await update($, settingOverrides, (o) => ({ ...o, [field]: { from, to } }));
}

function excerptOf(s: Settings): Excerpt | null {
  return s.excerpt ? { mode: s.excerptMode, top: s.excerptTop, bottom: s.excerptBottom } : null;
}

type Token = { norm: string; start: number; end: number };
type RowToken = Token & { row: string };
type CaptionWord = { norm: string; start_ms: number; end_ms: number };
type Caption = {
  text?: string;
  words?: { text_start: number; text_end: number; start_ms: number; end_ms: number }[];
};
type Status = {
  active?: boolean;
  paused?: boolean;
  captions?: Caption;
  position_ms?: number;
  fragment_index?: number;
};

// Markdown that is not spoken, besides fenced code blocks (fenceSpans): link targets and HTML
// tags. Inline `code` is spoken; speakable() drops its backticks and reads a dot in it as "dot".
const UNSPOKEN = /\]\([^)\n]*\)|<[^>\n]+>/g;
// The bullet or number that opens a list item: never spoken, so never a caption token.
const LIST_MARK = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm;
// Lines a skip-sections read drops: headings, bullet and numbered items, horizontal rules, table rows.
const SKIPPED = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|| ?([-*_]) ?(?:\1 ?){2,}$)/;

export function wordTokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    norm: m[0].toLowerCase(),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length
  }));
}

// Inline `code` spans, and a dot between two names inside one: `export.ts`, `os.path`.
const CODE_SPAN = /`[^`\n]+`/g;
const CODE_DOT = /[A-Za-z_]\w*\.(?=\w)/g;
// One character standing in for a dot that is said as "dot". It keeps every markdown offset.
const DOT_MARK = "\u0001";

// Spoken tokens of a reply's markdown (offsets into the markdown) and the text sent to CopySpeech.
// A TTS engine reads "." as a pause, so a dot in inline code is said as the word "dot".
// ponytail: pairs backticks left to right; one stray backtick can mark prose as code.
export function speakable(md: string) {
  const fences = fenceSpans(md);
  const skip = [
    ...fences.map((f) => ({ s: f.start, e: f.end })),
    ...[...md.matchAll(UNSPOKEN), ...md.matchAll(LIST_MARK)].map((m) => ({
      s: m.index ?? 0,
      e: (m.index ?? 0) + m[0].length
    }))
  ];
  const skipped = (at: number) => skip.some((r) => at >= r.s && at < r.e);
  const dots = [...md.matchAll(CODE_SPAN)]
    .flatMap((span) =>
      [...span[0].matchAll(CODE_DOT)].map(
        (m) => (span.index ?? 0) + (m.index ?? 0) + m[0].length - 1
      )
    )
    .filter((at) => !skipped(at));
  const tokens = [
    ...wordTokens(md).filter((t) => !skipped(t.start)),
    ...dots.map((at) => ({ norm: "dot", start: at, end: at + 1 }))
  ].sort((a, b) => a.start - b.start);
  let marked = md;
  for (const at of dots) marked = marked.slice(0, at) + DOT_MARK + marked.slice(at + 1);
  // Same length as md until here, so the fence offsets hold; cut the last fence first.
  for (const f of [...fences].reverse())
    marked = marked.slice(0, f.start) + " " + marked.slice(f.end);
  const speech = marked
    .replace(UNSPOKEN, " ")
    .replace(/`+/g, "")
    .replace(LIST_MARK, "")
    .replace(/[#*_>|~[]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .split(DOT_MARK)
    .join(" dot ");
  return { tokens, speech };
}

export type Excerpt = { mode: string; top: number; bottom: number };

function clampCount(n: number): number {
  return Number.isFinite(n)
    ? Math.min(EXCERPT_MAX, Math.max(EXCERPT_MIN, Math.round(n)))
    : EXCERPT_MIN;
}

// Same rules as copyspeech-hermes excerptSpeech: keep the first and last paragraphs.
export function pickParagraphs<T>(paras: T[], { mode, top, bottom }: Excerpt): T[] {
  if (paras.length < 2) return paras;
  const t = clampCount(top);
  const b = clampCount(bottom);
  if (mode === "top") return paras.slice(0, t);
  if (mode === "bottom") return paras.slice(-b);
  if (t + b >= paras.length) return paras;
  return paras.slice(0, t).concat(paras.slice(-b));
}

// Same length as md: each skipped line becomes spaces, so offsets into md still hold.
function maskSkipped(md: string): string {
  return md
    .split("\n")
    .map((line) => (SKIPPED.test(line) ? " ".repeat(line.length) : line))
    .join("\n");
}

// Paragraphs as [start, end) offsets into md. Blank lines split them, and a skipped
// line is neither text nor a split, so a list between two sentences joins them.
function paragraphs(md: string, skip: boolean): Block[] {
  const out: Block[] = [];
  let from = -1;
  let to = -1;
  let open: string | null = null;
  let offset = 0;
  for (const line of md.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    open = fenceAfter(open, line);
    if (skip && SKIPPED.test(line)) continue;
    if (line.trim() === "" && open === null) {
      if (from >= 0) out.push({ start: from, end: to });
      from = -1;
    } else {
      if (from < 0) from = start;
      to = start + line.length;
    }
  }
  if (from >= 0) out.push({ start: from, end: to });
  return out;
}

export type Part = { row: string; md: string; from?: number; to?: number };
export type Spoken = { speech: string; tokens: RowToken[] };

// What a play-button or automatic read speaks, and the tokens the captions align to.
// Tokens hold offsets into their row's markdown, and they are exactly the words of
// `speech`: a skipped line or an excerpt gap adds no token.
export function prepareSpeech(parts: Part[], skip: boolean, excerpt: Excerpt | null): Spoken {
  const paras: { speech: string; tokens: RowToken[] }[] = [];
  for (const { row, md, from = 0, to = Infinity } of parts) {
    const masked = skip ? maskSkipped(md) : md;
    for (const p of paragraphs(md, skip)) {
      if (p.start < from || p.start >= to) continue;
      const piece = speakable(masked.slice(p.start, p.end));
      if (piece.speech === "") continue;
      const tokens = piece.tokens.map((t) => ({
        norm: t.norm,
        start: t.start + p.start,
        end: t.end + p.start,
        row
      }));
      paras.push({ speech: piece.speech, tokens });
    }
  }
  const kept = excerpt === null ? paras : pickParagraphs(paras, excerpt);
  return {
    speech: kept.map((p) => p.speech).join("\n\n"),
    tokens: kept.flatMap((p) => p.tokens)
  };
}

// What one line of a list block speaks: its own [from, to) of the markdown, with no skip or
// excerpt, since the person pressed its Read button. Tokens keep the reply's offsets.
export function prepareLine(row: string, md: string, from: number, to: number): Spoken {
  const piece = speakable(md.slice(from, to));
  return {
    speech: piece.speech,
    tokens: piece.tokens.map((t) => ({
      norm: t.norm,
      start: t.start + from,
      end: t.end + from,
      row
    }))
  };
}

// Caption entries grouped per spoken word. ElevenLabs sends one entry per character.
export function captionWords(caption: Caption): CaptionWord[] {
  const entries = caption.words ?? [];
  const words: CaptionWord[] = [];
  for (const token of wordTokens(caption.text ?? "")) {
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const entry of entries) {
      if (!(entry.text_end > token.start && entry.text_start < token.end)) continue;
      if (entry.end_ms <= entry.start_ms) continue;
      startMs = Math.min(startMs, entry.start_ms);
      endMs = Math.max(endMs, entry.end_ms);
    }
    if (endMs > startMs) words.push({ norm: token.norm, start_ms: startMs, end_ms: endMs });
  }
  return words;
}

function findNear(tokens: Token[], norm: string, from: number): number {
  const highest = Math.min(tokens.length, from + ALIGN_WINDOW);
  for (let scan = from; scan < highest; scan += 1) if (tokens[scan]?.norm === norm) return scan;
  return -1;
}

function runAt(
  words: CaptionWord[],
  tokens: Token[],
  i: number,
  at: number,
  need: number
): boolean {
  let cursor = at + 1;
  for (let k = i + 1; k < i + need; k += 1) {
    const found = findNear(tokens, words[k]?.norm ?? "", cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

function resync(words: CaptionWord[], tokens: Token[], i: number, from: number): number {
  const need = Math.min(RUN_NEEDED, words.length - i);
  if (need < 2) return -1;
  for (let scan = from; scan < tokens.length; scan += 1) {
    if (tokens[scan]?.norm === words[i]?.norm && runAt(words, tokens, i, scan, need)) return scan;
  }
  return -1;
}

// Same rules as copyspeech-hermes alignDetail: half the caption words must map.
export function align(words: CaptionWord[], tokens: Token[], from: number) {
  const map = words.map(() => -1);
  let cursor = from;
  let mapped = 0;
  for (let i = 0; i < words.length; i += 1) {
    let at = mapped === 0 ? -1 : findNear(tokens, words[i]?.norm ?? "", cursor);
    if (at >= 0 && !runAt(words, tokens, i, at, Math.min(RUN_NEEDED, words.length - i))) {
      const far = resync(words, tokens, i, cursor);
      if (far >= 0) at = far;
    }
    if (at < 0) at = resync(words, tokens, i, cursor);
    if (at < 0) continue;
    map[i] = at;
    cursor = at + 1;
    mapped += 1;
  }
  return { ok: mapped > 0 && mapped * 2 >= words.length, map, cursor };
}

// Rendered markdown per AssistantMessage row, and the rows first drawn in the
// current turn (the auto-read target). Module variables restart on reload; the
// atoms survive. Rows are collected only while a main turn runs: after a reload
// `rows` is empty, so every old reply that redraws would otherwise join the turn.
// ponytail: a reload mid-turn collects nothing for that turn; the pane's Read still works.
const rows = new Map<string, string>();
let turnRows: string[] = [];
// The last finished turn's answer row, for the pane's header Read.
let lastTurnRows: string[] = [];
let inTurn = false;
let counter = 0;

function beginTurn() {
  turnRows = [];
  inTurn = true;
}
type Run = {
  tokens: RowToken[];
  cursor: number;
  key: string;
  words: CaptionWord[];
  map: number[] | null;
  // The spoken word and the pane block that holds it, as last written.
  mark: string;
  block: string;
  startedAt: number;
  lastActive: number;
  // True once this reading's /speak answered. /status carries no request id, so before
  // that it can still describe the reading this one replaced.
  heard: boolean;
};
function freshRun(tokens: RowToken[], now: number): Run {
  return {
    tokens,
    cursor: 0,
    key: "",
    words: [],
    map: null,
    mark: "",
    block: "",
    startedAt: now,
    lastActive: 0,
    heard: false
  };
}
let run = freshRun([], 0);

type ControlBody = { request_id?: string; text?: string; wait?: boolean };

// Resolves null on success, else why the request failed.
function post($: EngineInterface, path: string, body: ControlBody): Promise<string | null> {
  return $.http
    .fetch(CONTROL + path, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body)
    })
    .then((r) => (r.ok ? null : `HTTP ${r.status} ${r.text.slice(0, 200)}`))
    .catch(String);
}

// Tokens of whole rows, for a selection, whose speech is a piece of one row.
function rowTokens(ids: string[]): RowToken[] {
  return ids.flatMap((row) => speakable(rows.get(row) ?? "").tokens.map((t) => ({ ...t, row })));
}

// The key of block `n` of `row` in the captions pane.
function blockKey(row: string, n: number): string {
  return `b-${row}-${n}`;
}

// Moves the spoken word to `at` in `row`; null clears it. Writes only a change, and
// scrolls the pane only when the word enters another block.
// ponytail: scrolls per block, so a block taller than the pane shows its top; split blocks into lines if that bites.
async function paint($: EngineInterface, row: string, at: [number, number] | null) {
  const key = at === null ? "" : `${row}:${at[0]}:${at[1]}`;
  if (key === run.mark) return;
  run.mark = key;
  await update($, spoken, () => (at === null ? null : { row, at }));
  if (at === null) return;
  const n = blocks(rows.get(row) ?? "").findIndex((b) => at[0] >= b.start && at[0] < b.end);
  const block = n < 0 ? "" : blockKey(row, n);
  if (block === "" || block === run.block) return;
  // A pane not drawn yet refuses the scroll; the next word tries again.
  const moved = await $.ui
    .scroll({ in: PANE, to: { key: block }, block: "center" })
    .catch(() => ({ deny: "scroll failed" }));
  if (moved.deny === undefined) run.block = block;
}

// Clears reading `id`, unless a newer reading has started. The check sits inside the write,
// so a start that lands meanwhile keeps its reading.
async function endIfCurrent($: EngineInterface, id: string) {
  const mine = run;
  let ended = false;
  await update($, reading, (r) => {
    if (r?.id !== id) return r;
    ended = true;
    return null;
  });
  if (ended && run === mine) await paint($, "", null);
}

// `$.http.fetch` gives up after 30 s with no answer. CopySpeech answers a
// wait:false /speak once the reading is audible; queued behind another
// reading, that can take longer, so a give-up means the reading still runs
// and the /status poll owns it.
const STILL_RUNNING = /aborted|no complete answer/i;

// The replies a reading covers, as the captions pane shows them.
function shownRows(ids: string[]): ShownRow[] {
  return ids.filter((row) => rows.has(row)).map((row) => ({ row, md: rows.get(row) ?? "" }));
}

// Starts run one at a time: two overlapping starts would each miss the other's reading, and
// both would play.
// ponytail: a start waits for the previous /speak's answer, up to 30 s when CopySpeech queues it.
let starting: Promise<void> = Promise.resolve();
function start($: EngineInterface, ids: string[], text: Spoken): Promise<void> {
  const next = starting.then(() => startNow($, ids, text));
  starting = next.catch(() => undefined);
  return next;
}

// Speaks `text`; the captions pane shows `ids`, the AssistantMessage rows it comes from.
async function startNow($: EngineInterface, ids: string[], text: Spoken) {
  // Nothing to say keeps the reading that plays: a press on a silent block must not stop it.
  if (text.speech.trim() === "" || ids.length === 0) return;
  const current = await read($, reading);
  if (current !== null) await post($, "/stop", { request_id: current.id });
  counter += 1;
  const id = `claude.${Date.now()}.${counter}`;
  await paint($, "", null);
  const mine = freshRun(text.tokens, await $.clock.now());
  run = mine;
  // A selection outside any reply has no rows to show; the pane keeps what it had.
  const before = await read($, history);
  const shown = shownRows(ids);
  if (shown.length > 0) await update($, history, () => shown);
  await update($, reading, (): Reading => ({ id, rows: ids, paused: false }));
  const failure = await post($, "/speak", { text: text.speech, request_id: id, wait: false });
  if (failure !== null && !STILL_RUNNING.test(failure)) {
    $.ui.toast(`CopySpeech /speak failed: ${failure}`);
    if ((await read($, reading))?.id === id) await update($, history, () => before);
    await endIfCurrent($, id);
    return;
  }
  // Stopped or replaced while /speak waited: stop this one too, or it plays untracked.
  if ((await read($, reading))?.id !== id) {
    await post($, "/stop", { request_id: id });
    return;
  }
  // Audible, or queued past the fetch's give-up: statuses from here on are this reading's.
  mine.heard = true;
  mine.startedAt = await $.clock.now();
}

// Opens the captions pane while captions are on. Called from a press it is asked, so
// the terminal places it at any width; from auto-read it waits for 144 columns.
async function openPane($: EngineInterface, captions: boolean) {
  if (captions) await $.ui.open({ id: PANE, title: "CopySpeech Reader" }).catch(() => undefined);
}

// A /stop with no request_id is CopySpeech's global stop, as the tray's Stop
// reading: it also aborts every queued and running synthesis. The band clears at
// once, so a CopySpeech that is down cannot leave it stuck. Resolves the failure, or null.
async function stop($: EngineInterface): Promise<string | null> {
  await paint($, "", null);
  await update($, reading, () => null);
  return post($, "/stop", {});
}

// Pause or Resume the reading. The band above the prompt and the pane's header row draw it.
const pauseOrResume = ($: EngineInterface, r: Reading) => () =>
  void $.clock.after(0, async () => {
    const verb = r.paused ? "resume" : "pause";
    const failure = await post($, `/${verb}`, { request_id: r.id });
    if (failure !== null) $.ui.toast(`CopySpeech /${verb} failed: ${failure}`);
  });

// Stops the reading, as the band's and the pane's Stop do.
const stopReading = ($: EngineInterface) => () =>
  void $.clock.after(0, async () => {
    const failure = await stop($);
    if (failure !== null) $.ui.toast(`CopySpeech /stop failed: ${failure}`);
  });

// One poll at a time: a /status slower than POLL_MS would start a second, and answers that
// land out of order move the chip back or flip Pause and Resume.
let polling = false;
async function poll($: EngineInterface) {
  if (polling) return;
  polling = true;
  try {
    await pollOnce($);
  } finally {
    polling = false;
  }
}

async function pollOnce($: EngineInterface) {
  const current = await read($, reading);
  // Until /speak answers, /status may still describe the reading this one replaced.
  const run0 = run;
  if (current === null || !run0.heard) return;
  const now = await $.clock.now();
  const res = await $.http.fetch(CONTROL + "/status").catch(() => null);
  // A start since the fetch began owns `run` now; this answer is not its.
  if (res === null || !res.ok || run !== run0) return;
  let s: Status;
  try {
    // SAFETY: /status is CopySpeech's own control-server contract, and every
    // Status field is optional and read with a fallback.
    s = JSON.parse(res.text) as Status;
  } catch {
    return;
  }
  if (s.active !== true) {
    // The app sends a bare `{ active: false }` when a reading ends or stops, and after a
    // silent stretch. While synthesis runs behind playback it sends the last position with
    // active false: the reading goes on. So only a bare report, past the idle wait, or
    // silence past SILENT_STOP_MS ends the reading here.
    const silentFor = now - (run.lastActive > 0 ? run.lastActive : run.startedAt);
    const bare = s.position_ms === undefined;
    const idle = bare && run.lastActive > 0 && silentFor > IDLE_STOP_MS;
    if (idle || silentFor > SILENT_STOP_MS) await endIfCurrent($, current.id);
    return;
  }
  run.lastActive = now;
  const caption = s.captions ?? {};
  const key = `${s.fragment_index ?? 0}:${caption.text ?? ""}`;
  if (key !== run.key) {
    run.words = captionWords(caption);
    const a = align(run.words, run.tokens, run.cursor);
    // A miss stays unkeyed, so the next poll retries.
    run.map = a.ok ? a.map : null;
    if (a.ok) {
      run.key = key;
      run.cursor = a.cursor;
    }
  }
  const paused = s.paused === true;
  if (paused !== current.paused) {
    await update($, reading, (r) => (r?.id === current.id ? { ...r, paused } : r));
    if (run !== run0) return;
  }
  const pos = s.position_ms ?? 0;
  const i = run.words.findIndex((w) => pos >= w.start_ms && pos < w.end_ms);
  const at = i >= 0 && run.map !== null ? (run.map[i] ?? -1) : -1;
  const token = at >= 0 ? run.tokens[at] : undefined;
  // Hold the last word between words, as Hermes does.
  if (token !== undefined) await paint($, token.row, [token.start, token.end]);
}

// The plugin's own `/config` row for one `userConfig` field, when the list returns it. On the
// desktop app the list may return none of the plugin's rows, so writes do not depend on it.
async function settingRow($: EngineInterface, field: string) {
  const list = await $.config.list().catch(() => []);
  return list.find((r) => r.key.startsWith("copyspeech") && r.key.endsWith(`.${field}`));
}

// Writes one of the plugin's settings, trying each key: the listed row's, else the two names a
// plugin's row takes, `<name>@inline` (a folder loaded with --plugin-dir) and `<name>`. Resolves
// undefined on a write, else the reason the last key was refused.
async function writeSetting(
  $: EngineInterface,
  row: { key: string } | undefined,
  field: string,
  value: SettingValue
): Promise<string | undefined> {
  const keys =
    row === undefined ? [`${PLUGIN_NAME}@inline.${field}`, `${PLUGIN_NAME}.${field}`] : [row.key];
  let deny = `no ${field} row`;
  for (const key of keys) {
    const res = await $.config.set({ key, value }).catch((err) => ({ deny: String(err) }));
    if (res.deny === undefined) return undefined;
    deny = res.deny;
  }
  return `${deny} (tried ${keys.join(", ")})`;
}

// Writes one setting and, once the engine takes it, records it so the plugin uses it before
// a reload. Resolves a deny's reason.
async function saveSetting(
  $: EngineInterface,
  loaded: Settings,
  field: keyof Settings,
  value: SettingValue
): Promise<string | undefined> {
  const deny = await writeSetting($, await settingRow($, field), field, value);
  if (deny === undefined) await recordOverride($, field, loaded[field], value);
  return deny;
}

// Flips the "Read new replies aloud" setting, as if the person changed it in /config. The
// listed value wins; without a listed row, the value in force does. Resolves the reply text.
async function toggleAutoRead($: EngineInterface, loaded: Settings): Promise<string> {
  const row = await settingRow($, "autoRead");
  const enabled = !(row === undefined
    ? (await settingsNow($, loaded)).autoRead
    : row.value === true);
  const deny = await writeSetting($, row, "autoRead", enabled);
  if (deny !== undefined) return `CopySpeech auto-read unchanged: ${deny}`;
  await recordOverride($, "autoRead", loaded.autoRead, enabled);
  return enabled ? "CopySpeech auto-read is on." : "CopySpeech auto-read is off.";
}

export const register: Register = (on, options) => {
  // The settings the plugin loaded with. A write from the pane or /copyspeech-autoread
  // applies at once through `settingOverrides` (settingsNow), before any reload.
  const loaded: Settings = {
    autoRead: options.autoRead === true,
    skipSections: options.skipSections === true,
    excerpt: options.excerpt !== false,
    excerptMode: String(options.excerptMode ?? "both"),
    excerptTop: Number(options.excerptTop ?? 2),
    excerptBottom: Number(options.excerptBottom ?? 2),
    captions: options.captions !== false
  };
  const forRead = (s: Settings, ids: string[]) =>
    prepareSpeech(
      ids.map((row) => ({ row, md: rows.get(row) ?? "" })),
      s.skipSections,
      excerptOf(s)
    );

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "copyspeech-stop",
      description: "Stop the CopySpeech reading"
    });
    await $.command.register({
      name: "copyspeech-autoread",
      description: "Turn reading new replies aloud on or off"
    });
    await $.command.register({
      name: "copyspeech-settings",
      description: "Open the CopySpeech Reader pane with its settings"
    });
    const health = await $.http
      .fetch(CONTROL + "/health")
      .then((r) => (r.ok ? null : `HTTP ${r.status}`))
      .catch(String);
    if (health !== null) $.ui.toast(`CopySpeech /health failed: ${health}`);
    // ponytail: one global 120 ms timer that idles without a reading; start/stop it per reading if it ever shows in profiles.
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined));
    return next(e);
  });

  on("command.run", { command: "copyspeech-stop" }, async ($) => {
    const failure = await stop($);
    return { text: failure === null ? "Stopped." : `CopySpeech /stop failed: ${failure}` };
  });

  on("command.run", { command: "copyspeech-autoread" }, async ($) => ({
    text: await toggleAutoRead($, loaded)
  }));

  on("command.run", { command: "copyspeech-settings" }, async ($) => {
    await $.ui.open({ id: PANE, title: "CopySpeech Reader" }).catch(() => undefined);
    return { text: "CopySpeech settings are in the Reader pane." };
  });

  // The person's own prompt places the captions pane at any width. An auto-read that opens
  // it at turn end is unasked, and the engine may hold that open undrawn on a narrow window.
  // A prompt starts a turn: the person's own, so turn.start also starting one is harmless.
  on("prompt.submit", async ($, e, next) => {
    if (e.isMeta !== true) {
      beginTurn();
      const s = await settingsNow($, loaded);
      if (s.autoRead) void openPane($, s.captions);
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) beginTurn();
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    inTurn = false;
    // The turn's last text block: the answer. Earlier blocks are mostly narration between tool
    // calls ("Let me read the file"), and the excerpt's top paragraphs would land on them.
    const ids = turnRows.slice(-1);
    if (ids.length === 0) return result;
    lastTurnRows = ids;
    const s = await settingsNow($, loaded);
    if (s.autoRead && e.reason === "answer") {
      void $.clock.after(0, async () => {
        // The pane may wait undrawn (below 144 columns), so the reading never waits for it.
        void openPane($, s.captions);
        await start($, ids, forRead(s, ids)).catch(() => undefined);
      });
    }
    return result;
  });

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e);
    if (inTurn && !rows.has(e.requestId)) turnRows.push(e.requestId);
    rows.set(e.requestId, e.props.text);
    const s = await settingsNow($, loaded);
    const r = await read($, reading);
    const isMine = r !== null && r.rows.includes(e.requestId);
    const ui = $.ui.resolve(e);
    const { Box, Button } = ui;
    // The engine draws the reply's own Markdown; the captions pane shows the spoken word.
    const body = await next(e);
    // The terminal keeps its ▶ mark; the desktop button is the plain word Read.
    const play = (
      <Button
        key={`play-${e.requestId}`}
        label={e.surface === "terminal" ? "▶ Read" : "Read"}
        onPress={() => {
          void openPane($, s.captions);
          void $.clock.after(
            0,
            () => void start($, [e.requestId], forRead(s, [e.requestId])).catch(() => undefined)
          );
        }}
      />
    );
    // The play button is absolute: it leaves the flow, so the hover reveal moves
    // nothing. It stays inside the row's own bounds (bottom right): the desktop clips
    // an absolute Box at its row, so a negative offset hides it behind the row above.
    // It keeps one shape at every state and hides on the reply being read: that
    // reply's Pause, Resume and Stop sit in the band above the prompt.
    const REVEAL = { display: "flex" } as const;
    return (
      <Box key={`row-${e.requestId}`} flexDirection="column">
        {body}
        <Box
          position="absolute"
          bottom={0}
          right={0}
          alignItems="center"
          display="none"
          hover={isMine ? undefined : REVEAL}
        >
          {play}
        </Box>
      </Box>
    );
  });

  // The band above the prompt holds the reading's Pause, Resume and Stop. It reads
  // only `reading`, which changes at start, pause, resume and stop, so it never
  // redraws per caption word: the buttons stay still while the spoken word moves.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const r = await read($, reading);
    if (r === null) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box gap="xs" alignItems="center">
        <Text dimColor>CopySpeech reading</Text>
        <Button key="pause" label={r.paused ? "Resume" : "Pause"} onPress={pauseOrResume($, r)} />
        <Button key="stop" label="Stop" onPress={stopReading($)} />
      </Box>
    );
  });

  // The captions pane: the reading's replies drawn from their Markdown, one keyed Box per
  // block, the chip on the spoken word. It alone reads `spoken`, so a word redraws it alone.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const r = await read($, reading);
    const s = await read($, spoken);
    const list = await read($, history);
    const open = await read($, settingsOpen);
    const ui = $.ui.resolve(e);
    const { Box, Button, Code, Markdown, Text } = ui;
    // The colored CopySpeech mark heads the header row.
    const logoSvg =
      e.surface !== "terminal" && "Svg" in ui ? (
        <ui.Svg source={ICON_SVG} alt="CopySpeech" width={16} height={16} />
      ) : null;
    // Buttons here redraw with every spoken word. The header row shows them while a reading plays anyway.
    const shown = await settingsNow($, loaded);
    const save = (field: keyof Settings, value: SettingValue) => () =>
      void $.clock.after(0, async () => {
        const deny = await saveSetting($, loaded, field, value).catch((err) => String(err));
        if (deny !== undefined) $.ui.toast(`CopySpeech ${field} unchanged: ${deny}`);
      });
    const toggle = (field: "autoRead" | "skipSections" | "excerpt" | "captions", label: string) => (
      <Button
        key={field}
        label={`${label}: ${shown[field] ? "On" : "Off"}`}
        onPress={save(field, !shown[field])}
      />
    );
    const nextMode =
      EXCERPT_MODES[(EXCERPT_MODES.indexOf(shown.excerptMode) + 1) % EXCERPT_MODES.length] ??
      "both";
    // Hidden until the person opens Settings from the header row.
    const settingsBody = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap="xs">
          <Text dimColor>Reading</Text>
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {toggle("autoRead", "Auto-read")}
            {toggle("skipSections", "Skip sections")}
            {toggle("excerpt", "Excerpt")}
            <Button
              key="excerptMode"
              label={`Part: ${shown.excerptMode}`}
              onPress={save("excerptMode", nextMode)}
            />
          </Box>
          {/* On the desktop app the engine's config list does not return these two number rows,
              so the pane cannot write them. It shows them and says where to change them. */}
          <Text dimColor>
            {`Top ${shown.excerptTop} · Bottom ${shown.excerptBottom}. Change in /config or settings.json.`}
          </Text>
        </Box>
        <Box flexDirection="column" gap="xs">
          <Text dimColor>Captions</Text>
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {toggle("captions", "Show captions")}
          </Box>
        </Box>
      </Box>
    );
    // Reads one paragraph of the reply, [from, to), with the captions for that reading. The
    // person pressed it, so it reads in full, with no skip or excerpt, as a list item does.
    const readParagraph = (row: string, md: string, from: number, to: number) => () =>
      void $.clock.after(0, () => {
        rows.set(row, md);
        void start($, [row], prepareSpeech([{ row, md, from, to }], false, null)).catch(
          () => undefined
        );
      });
    // Reads one line of a list block, so each item speaks alone.
    const readLine = (row: string, md: string, from: number, to: number) => () =>
      void $.clock.after(0, () => {
        rows.set(row, md);
        void start($, [row], prepareLine(row, md, from, to)).catch(() => undefined);
      });
    // A Read button: the plain word Read on every surface.
    const readButton = (key: string, onPress: () => void) => (
      <Button key={key} label="Read" onPress={onPress} />
    );
    // A paragraph's Read button, on a block that is not a list.
    const paragraphRead = (row: string, md: string, n: number, b: Block) =>
      readButton(`read-${row}-${n}`, readParagraph(row, md, b.start, b.end));
    // The reply the latest reading covers. A paragraph's Read button shows on hover at its side.
    const replies = list.map((entry) => {
      const mark = s !== null && s.row === entry.row ? s.at : null;
      const inline = (from: number, to: number) =>
        inlineSpans(entry.md, from, to, mark).map((sp) => (
          <Text
            bold={sp.bold}
            italic={sp.italic}
            mono={sp.mono}
            strikethrough={sp.strike}
            underline={sp.link}
            color={sp.link ? LINK : undefined}
            {...(sp.hit ? CHIP : {})}
          >
            {sp.text}
          </Text>
        ));
      // One drawn row of a block. Text holds the chip; a fence is not spoken, so it gets none.
      // `markWidth` is the cells of a list's marker column; only a list block has items.
      const drawLine = (ln: Line, k: number, markWidth = 2) => {
        switch (ln.kind) {
          case "heading":
            return (
              <Text key={String(k)} weight="bold" size={ln.level <= 2 ? "heading" : "body"}>
                {inline(ln.start, ln.end)}
              </Text>
            );
          case "item":
            // The marker has its own column, as wide as the list's widest marker plus one cell.
            // The marker Text has no trailing space, which a surface may trim, so the text starts
            // in the same column on every item and wrapped lines hang under it. The row top-aligns
            // its columns, so a wrapped item keeps its marker on the first line.
            return (
              <Box
                key={String(k)}
                flexDirection="row"
                alignItems="flex-start"
                paddingLeft={Math.min(ln.indent, 4) * 2}
              >
                <Box flexShrink={0} width={markWidth}>
                  <Text>{ln.marker}</Text>
                </Box>
                <Box flexShrink={1} flexGrow={1}>
                  <Text>{inline(ln.start, ln.end)}</Text>
                </Box>
              </Box>
            );
          case "quote":
            // Top-aligned like items, so a wrapped quote keeps its bar on the first line.
            return (
              <Box key={String(k)} flexDirection="row" alignItems="flex-start">
                <Box flexShrink={0} width={2}>
                  <Text dimColor>│</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text italic>{inline(ln.start, ln.end)}</Text>
                </Box>
              </Box>
            );
          case "rule":
            return (
              <Text key={String(k)} dimColor>
                {"─".repeat(24)}
              </Text>
            );
          case "fence":
            return (
              <Code
                key={String(k)}
                source={ln.code}
                language={ln.lang === "" ? undefined : ln.lang}
              />
            );
          case "table": {
            const row = (cells: Block[], head: boolean, i: number) => (
              <Box key={String(i)} flexDirection="row" gap="sm">
                {cells.map((c, j) => (
                  <Box
                    key={String(j)}
                    flexGrow={1}
                    flexShrink={1}
                    width={`${Math.floor(100 / cells.length)}%`}
                  >
                    <Text weight={head ? "bold" : undefined}>{inline(c.start, c.end)}</Text>
                  </Box>
                ))}
              </Box>
            );
            return (
              <Box key={String(k)} flexDirection="column">
                {ln.header === null ? null : row(ln.header, true, -1)}
                {ln.rows.map((cells, i) => row(cells, false, i))}
              </Box>
            );
          }
          default:
            return <Text key={String(k)}>{inline(ln.start, ln.end)}</Text>;
        }
      };
      // The block that holds the spoken word is drawn here, so the chip can sit on the word.
      // Every other block is the engine's own Markdown, which is the transcript's look.
      return (
        <Box key={`reply-${entry.row}`} flexDirection="column" gap={1}>
          {blocks(entry.md).map((b, n) => {
            const lines = blockLines(entry.md, b);
            // A list block is drawn line by line, and each line with words gets its own Read
            // button on hover. A table keeps none: its cells are not split yet.
            if (lines.some((ln) => ln.kind === "item")) {
              const markWidth =
                1 +
                Math.max(
                  0,
                  ...lines.flatMap((ln) => (ln.kind === "item" ? [ln.marker.length] : []))
                );
              return (
                <Box key={blockKey(entry.row, n)} flexDirection="column">
                  <Box flexDirection="column">
                    {lines.map((ln, k) => {
                      const line = drawLine(ln, k, markWidth);
                      if (ln.kind === "rule" || ln.kind === "fence" || ln.kind === "table")
                        return line;
                      return (
                        <Box key={`${blockKey(entry.row, n)}/${k}`} flexDirection="column">
                          {line}
                          <Box
                            position="absolute"
                            right={0}
                            top={0}
                            display="none"
                            hover={{ display: "flex" }}
                          >
                            {readButton(
                              `read-${entry.row}-${n}-${k}`,
                              readLine(entry.row, entry.md, ln.start, ln.end)
                            )}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              );
            }
            const holdsWord =
              s !== null && s.row === entry.row && s.at[0] >= b.start && s.at[0] < b.end;
            // Code and rules are never spoken, so a block of only those gets no Read button.
            const silent = lines.every((ln) => ln.kind === "fence" || ln.kind === "rule");
            return (
              <Box key={blockKey(entry.row, n)} flexDirection="column">
                <Box flexDirection="column">
                  {holdsWord ? (
                    lines.map((ln, k) => drawLine(ln, k))
                  ) : (
                    <Markdown text={entry.md.slice(b.start, b.end)} />
                  )}
                </Box>
                {silent ? null : (
                  <Box
                    position="absolute"
                    right={0}
                    top={0}
                    display="none"
                    hover={{ display: "flex" }}
                  >
                    {paragraphRead(entry.row, entry.md, n, b)}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      );
    });
    // The header row: the CopySpeech mark, its name, then the playbox. While a reading plays the
    // name reads CopySpeech Reading, with Pause or Resume and Stop. While nothing plays it shows
    // Read, which reads the last finished turn's answer as auto-read does, else the replies the
    // pane shows. Settings is always here, and its body opens under the row. The header scrolls
    // with the pane body.
    const readLatest = () =>
      void $.clock.after(0, () => {
        // After a reload `rows` is empty; the pane's own history still holds the text.
        for (const h of list) if (!rows.has(h.row)) rows.set(h.row, h.md);
        const ids = lastTurnRows.length > 0 ? lastTurnRows : list.map((h) => h.row);
        if (ids.length === 0) {
          $.ui.toast("CopySpeech has no reply to read yet.");
          return;
        }
        void start($, ids, forRead(shown, ids)).catch(() => undefined);
      });
    const header = (
      <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
        {logoSvg}
        <Text weight="bold">{r === null ? "CopySpeech" : "CopySpeech Reading"}</Text>
        {r === null ? <Button key="pane-read" label="Read" onPress={readLatest} /> : null}
        {r === null ? null : (
          <Button
            key="pane-pause"
            label={r.paused ? "Resume" : "Pause"}
            onPress={pauseOrResume($, r)}
          />
        )}
        {r === null ? null : <Button key="pane-stop" label="Stop" onPress={stopReading($)} />}
        <Button
          key="settings"
          label={open ? "Settings ▾" : "Settings ▸"}
          onPress={() => void $.clock.after(0, () => void update($, settingsOpen, (v) => !v))}
        />
      </Box>
    );
    return (
      <Box flexDirection="column" flexGrow={1} gap={1} paddingX={3} paddingY={1}>
        <Box flexDirection="column" gap={1}>
          {header}
          {open ? settingsBody : null}
        </Box>
        <Box flexDirection="column" flexGrow={1} gap={3}>
          {replies.length === 0 ? <Text dimColor>Nothing read yet.</Text> : replies}
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "ContextMenu" }, async ($, e, next) => {
    const selected = e.props.selection?.text;
    const row = e.props.row;
    if (selected === undefined || selected.trim() === "") return next(e);
    const { captions } = await settingsNow($, loaded);
    const { Button, Text } = $.ui.resolve(e);
    // A selection inside a reply paints there; elsewhere it reads without captions.
    const target = row?.component === "AssistantMessage" ? row.requestId : "none";
    return (
      <Button
        key="read-selection"
        onPress={() => {
          if (target !== "none") void openPane($, captions);
          void $.clock.after(
            0,
            () =>
              void start($, [target], { speech: selected, tokens: rowTokens([target]) }).catch(
                () => undefined
              )
          );
        }}
      >
        Read aloud with CopySpeech <Text dimColor>Speaks the selection</Text>
      </Button>
    );
  });
};

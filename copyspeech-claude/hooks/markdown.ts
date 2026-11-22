// Markdown for the captions pane. Every range is an offset into the reply's markdown,
// so the chip lands on the spoken word. Pure: register.tsx draws what this returns.

export type Block = { start: number; end: number };
export type Span = {
  text: string;
  bold?: true;
  italic?: true;
  mono?: true;
  strike?: true;
  link?: true;
  hit?: true;
};

// A line that starts with a fence mark: it opens a fenced code block, or closes the open one.
const FENCE_LINE = /^\s*(```|~~~)/;

// The fence mark still open after `line`, or null. One rule for every reader of fences: a fence
// opens on a line that starts with ``` or ~~~ and closes on a later line that starts with the
// same mark; the other mark inside it is code. A mark in mid-line is no fence.
export function fenceAfter(open: string | null, line: string): string | null {
  const mark = FENCE_LINE.exec(line)?.[1];
  if (mark === undefined) return open;
  if (open === null) return mark;
  return mark === open ? null : open;
}

// Fenced code blocks as [start, end) offsets into md, from the opening line to the closing
// line. An unclosed fence runs to the end.
export function fenceSpans(md: string): Block[] {
  const out: Block[] = [];
  let open: string | null = null;
  let from = 0;
  let offset = 0;
  for (const line of md.split("\n")) {
    const was = open;
    open = fenceAfter(open, line);
    if (was === null && open !== null) from = offset;
    if (was !== null && open === null) out.push({ start: from, end: offset + line.length });
    offset += line.length + 1;
  }
  if (open !== null) out.push({ start: from, end: md.length });
  return out;
}
const HEADING = /^(#{1,6})\s+/;
const RULE = /^ {0,3}([-*_]) ?(?:\1 ?){2,}$/;
const ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+/;
const QUOTE = /^ {0,3}>\s?/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// Blank-line separated blocks, never splitting a fenced code block.
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  let from = -1;
  let open: string | null = null;
  let offset = 0;
  for (const line of md.split("\n")) {
    const end = offset + line.length;
    open = fenceAfter(open, line);
    if (line.trim() === "" && open === null) {
      if (from >= 0) out.push({ start: from, end: offset - 1 });
      from = -1;
    } else if (from < 0) from = offset;
    offset = end + 1;
  }
  if (from >= 0) out.push({ start: from, end: md.length });
  return out;
}

// The text of one drawn row: [start, end) is its content, without the marks that open the line.
export type Line =
  | { kind: "text"; start: number; end: number }
  | { kind: "quote"; start: number; end: number }
  | { kind: "heading"; level: number; start: number; end: number }
  | { kind: "item"; marker: string; indent: number; start: number; end: number }
  | { kind: "rule" }
  | { kind: "fence"; lang: string; code: string }
  | { kind: "table"; header: Block[] | null; rows: Block[][] };

// Table cells of one row, trimmed, as offsets into md.
function cellsOf(line: string, at: number): Block[] {
  const pipes = [...line.matchAll(/(?<!\\)\|/g)].map((m) => m.index ?? 0);
  const out: Block[] = [];
  pipes.forEach((p, k) => {
    const next = pipes[k + 1] ?? (line.slice(p + 1).trim() === "" ? -1 : line.length);
    if (next < 0) return;
    let s = p + 1;
    let e = next;
    while (s < e && /\s/.test(line[s] ?? "")) s += 1;
    while (e > s && /\s/.test(line[e - 1] ?? "")) e -= 1;
    out.push({ start: at + s, end: at + e });
  });
  return out;
}

// One block's rows. A plain line continues the text or item above it, as Markdown does.
// ponytail: no nested blocks inside an item or a quote, no setext headings, no HTML.
export function blockLines(md: string, block: Block): Line[] {
  const out: Line[] = [];
  const lines = md.slice(block.start, block.end).split("\n");
  let offset = block.start;
  let table: Extract<Line, { kind: "table" }> | null = null;
  let cont: Extract<Line, { kind: "text" | "item" }> | null = null;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n] ?? "";
    const at = offset;
    offset += line.length + 1;
    const end = at + line.length;
    let fence = fenceAfter(null, line);
    if (fence !== null) {
      const open = line.trim();
      const code: string[] = [];
      while (n + 1 < lines.length) {
        n += 1;
        const inner = lines[n] ?? "";
        offset += inner.length + 1;
        fence = fenceAfter(fence, inner);
        if (fence === null) break;
        code.push(inner);
      }
      out.push({
        kind: "fence",
        lang: open.slice(3).trim().split(/\s+/)[0] ?? "",
        code: code.join("\n")
      });
      table = null;
      cont = null;
      continue;
    }
    if (TABLE_ROW.test(line)) {
      if (table === null) {
        table = { kind: "table", header: null, rows: [] };
        out.push(table);
      }
      if (TABLE_SEP.test(line) && table.header === null && table.rows.length === 1) {
        table.header = table.rows.shift() ?? null;
      } else table.rows.push(cellsOf(line, at));
      cont = null;
      continue;
    }
    table = null;
    const heading = HEADING.exec(line);
    const rule = RULE.test(line);
    const item = ITEM.exec(line);
    const quote = QUOTE.exec(line);
    if (heading) {
      out.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        start: at + heading[0].length,
        end
      });
      cont = null;
    } else if (rule) {
      out.push({ kind: "rule" });
      cont = null;
    } else if (item) {
      const marker = item[2] ?? "-";
      cont = {
        kind: "item",
        marker: /\d/.test(marker) ? marker : "•",
        indent: Math.floor((item[1]?.length ?? 0) / 2),
        start: at + item[0].length,
        end
      };
      out.push(cont);
    } else if (quote) {
      out.push({ kind: "quote", start: at + quote[0].length, end });
      cont = null;
    } else if (cont !== null) {
      cont.end = end;
    } else {
      cont = { kind: "text", start: at + (line.length - line.trimStart().length), end };
      out.push(cont);
    }
  }
  return out;
}

// An HTML tag: never spoken (register.tsx UNSPOKEN), so never drawn.
const TAG = /^<[^>\n]+>/;

// Whether the emphasis mark `d` at `i` can open (or close) a span, as CommonMark's flanking rule:
// an opener has a non-space after it, a closer a non-space before it. A `_` mark also needs a
// non-word on its outer side, so snake_case stays text.
function flanks(md: string, i: number, d: string, open: boolean): boolean {
  const inner = (open ? md[i + d.length] : md[i - 1]) ?? "";
  const outer = (open ? md[i - 1] : md[i + d.length]) ?? "";
  if (inner === "" || /\s/.test(inner)) return false;
  return !(d.startsWith("_") && /[\p{L}\p{N}]/u.test(outer));
}

// [from, to) of the markdown as styled spans; `mark` (offsets into the whole reply) gets `hit`.
// A backslash escape draws its mark as text, and an HTML tag draws nothing (`<br>` a space).
// ponytail: **bold**, *italic*, ~~strike~~, `code` and [links](url); no images, no nested `***`.
export function inlineSpans(
  md: string,
  from: number,
  to: number,
  mark: [number, number] | null
): Span[] {
  const chars: Span[] = [];
  // The mark that opened the bold or italic span being drawn, or null.
  let bold: string | null = null;
  let italic: string | null = null;
  let mono = false;
  let strike = false;
  // The "]" that closes the link label being drawn.
  let linkEnd = -1;
  let i = from;
  while (i < to) {
    const rest = md.slice(i, to);
    if (i === linkEnd) {
      i += /^\]\([^)\n]*\)/.exec(rest)?.[0].length ?? 1;
      linkEnd = -1;
      continue;
    }
    // An escaped mark is drawn as text: the backslash goes, the mark stays at its own offset.
    if (!mono && /^\\[!-/:-@[-`{-~]/.test(rest)) i += 1;
    else if (!mono && TAG.test(rest)) {
      const tag = TAG.exec(rest)?.[0] ?? "";
      if (/^<br\s*\/?>$/i.test(tag)) chars.push({ text: " " });
      i += tag.length;
      continue;
    } else if (!mono && (rest.startsWith("**") || rest.startsWith("__"))) {
      const d = rest.slice(0, 2);
      if (bold === d ? flanks(md, i, d, false) : bold === null && flanks(md, i, d, true)) {
        bold = bold === null ? d : null;
        i += 2;
        continue;
      }
    } else if (!mono && rest.startsWith("~~")) {
      strike = !strike;
      i += 2;
      continue;
    } else if (rest.startsWith("`")) {
      mono = !mono;
      i += 1;
      continue;
    } else if (!mono && (rest.startsWith("*") || rest.startsWith("_"))) {
      const d = rest.slice(0, 1);
      if (italic === d ? flanks(md, i, d, false) : italic === null && flanks(md, i, d, true)) {
        italic = italic === null ? d : null;
        i += 1;
        continue;
      }
    } else {
      const label = mono || linkEnd >= 0 ? null : /^\[([^\]\n]*)\]\([^)\n]*\)/.exec(rest);
      if (label) {
        linkEnd = i + 1 + (label[1]?.length ?? 0);
        i += 1;
        continue;
      }
    }
    const ch = md[i] ?? "";
    if (ch === "\n") {
      // A soft break reads as a space, and the next line's indent is dropped.
      chars.push({ text: " " });
      i += 1;
      while (i < to && (md[i] === " " || md[i] === "\t")) i += 1;
      continue;
    }
    const span: Span = { text: ch };
    if (bold !== null) span.bold = true;
    if (italic !== null) span.italic = true;
    if (mono) span.mono = true;
    if (strike) span.strike = true;
    if (linkEnd >= 0) span.link = true;
    if (mark !== null && i >= mark[0] && i < mark[1]) span.hit = true;
    chars.push(span);
    i += 1;
  }
  // Merge neighbours that share every flag.
  const out: Span[] = [];
  for (const c of chars) {
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === c.bold &&
      last.italic === c.italic &&
      last.mono === c.mono &&
      last.strike === c.strike &&
      last.link === c.link &&
      last.hit === c.hit
    ) {
      last.text += c.text;
    } else out.push({ ...c });
  }
  return out;
}

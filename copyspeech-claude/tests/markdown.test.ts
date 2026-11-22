import { expect, test } from "claude-code/testing";

import { blockLines, blocks, fenceSpans, inlineSpans } from "../hooks/markdown";
import type { Line, Span } from "../hooks/markdown";
import { speakable } from "../hooks/register";

const text = (spans: Span[]) => spans.map((s) => s.text).join("");

test("blocks keep fences whole and split on blank lines", async () => {
  const md =
    "# Title\n\nSay **bold** and [link](https://a.b).\n\n```\nx\n\ny\n```\n\n~~~\np\n\nq\n~~~\n\n- item one";
  expect(blocks(md).map((b) => md.slice(b.start, b.end))).toEqual([
    "# Title",
    "Say **bold** and [link](https://a.b).",
    "```\nx\n\ny\n```",
    "~~~\np\n\nq\n~~~",
    "- item one"
  ]);
});

test("inline spans style marks, drop link targets, and put the chip on the spoken word only", async () => {
  const md = "Say **bold** and [a *link*](https://a.b) ~~gone~~ `x.y`.";
  const at = md.indexOf("bold");
  const spans = inlineSpans(md, 0, md.length, [at, at + 4]);
  expect(spans.map((s) => s.text).join("")).toBe("Say bold and a link gone x.y.");
  expect(spans.filter((s) => s.hit)).toEqual([{ text: "bold", bold: true, hit: true }]);
  expect(spans.find((s) => s.text === "a ")).toEqual({ text: "a ", link: true });
  expect(spans.find((s) => s.text === "link")).toEqual({ text: "link", italic: true, link: true });
  expect(spans.find((s) => s.text === "gone")).toEqual({ text: "gone", strike: true });
  expect(spans.find((s) => s.text === "x.y")).toEqual({ text: "x.y", mono: true });
  // A literal bracket stays.
  expect(text(inlineSpans("a [b] c", 0, 7, null))).toBe("a [b] c");
});

// Every word the pane can chip is a spoken token, and its span starts where the token does.
test("the chip lands on each spoken word of a reply drawn in any block", async () => {
  const md = [
    "## Plan",
    "Run it *now*",
    "and wait.",
    "",
    "1. first **step**",
    "   - nested `item.ts`",
    "> quoted [link](https://a.b) text",
    "",
    "| Name | Count |",
    "|------|-------|",
    "| alpha | 7 |"
  ].join("\n");
  const lines = blocks(md).flatMap((b) => blockLines(md, b));
  const ranges = lines.flatMap((ln): [number, number][] => {
    if (ln.kind === "table")
      return [ln.header ?? [], ...ln.rows].flat().map((c) => [c.start, c.end]);
    return "start" in ln ? [[ln.start, ln.end]] : [];
  });
  for (const t of speakable(md).tokens.filter((t) => t.norm !== "dot")) {
    const range = ranges.find(([s, e]) => t.start >= s && t.end <= e);
    expect(range).toBeDefined();
    if (range === undefined) continue;
    const spans = inlineSpans(md, range[0], range[1], [t.start, t.end]);
    expect(
      spans
        .filter((s) => s.hit)
        .map((s) => s.text)
        .join("")
    ).toBe(md.slice(t.start, t.end));
  }
});

test("block lines split headings, items, quotes, rules, fences and tables", async () => {
  const md = "# Title\nfirst\nsecond\n- a\n  more\n  - b\n3) c\n> q\n---";
  const kinds = (ls: Line[]) =>
    ls.map((l) => (l.kind === "item" ? `item:${l.marker}:${l.indent}` : l.kind));
  const lines = blockLines(md, { start: 0, end: md.length });
  expect(kinds(lines)).toEqual([
    "heading",
    "text",
    "item:•:0",
    "item:•:1",
    "item:3):0",
    "quote",
    "rule"
  ]);
  const body = (l: Line | undefined) =>
    l !== undefined && "start" in l ? md.slice(l.start, l.end) : "";
  expect(body(lines[0])).toBe("Title");
  // A plain line continues the text or item above it.
  expect(body(lines[1])).toBe("first\nsecond");
  expect(body(lines[2])).toBe("a\n  more");

  const fenced = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
  expect(blockLines(fenced, { start: 0, end: fenced.length })).toEqual([
    { kind: "fence", lang: "ts", code: "const a = 1;\n\nconst b = 2;" }
  ]);
  // An unclosed fence, as a half-written reply has, still draws its code.
  expect(blockLines("```\nx", { start: 0, end: 5 })).toEqual([
    { kind: "fence", lang: "", code: "x" }
  ]);

  const table = "| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |";
  const [t] = blockLines(table, { start: 0, end: table.length });
  expect(t?.kind).toBe("table");
  if (t?.kind !== "table") return;
  expect(t.header?.map((c) => table.slice(c.start, c.end))).toEqual(["a", "b"]);
  expect(t.rows.map((r) => r.map((c) => table.slice(c.start, c.end)))).toEqual([["1", "2"], ["3"]]);
});

// One fence rule for blocks, rows and speech: a line that starts with the open mark closes it.
test("a fence opens and closes on lines that start with its own mark", async () => {
  const words = (md: string) => speakable(md).tokens.map((t) => t.norm);

  // A mark in mid-line neither closes a fence nor opens one.
  const loose = "```\ncode\nend ``` trailing words\n```\nafter";
  expect(fenceSpans(loose)).toEqual([{ start: 0, end: loose.lastIndexOf("```") + 3 }]);
  expect(words(loose)).toEqual(["after"]);
  expect(words("use ```x``` inline here")).toEqual(["use", "x", "inline", "here"]);

  // The other mark inside a fence is code, and a blank line inside does not split the block.
  const mixed = "```\n~~~\n\ntext inside\n```\n\nout";
  expect(blocks(mixed).map((b) => mixed.slice(b.start, b.end))).toEqual([
    "```\n~~~\n\ntext inside\n```",
    "out"
  ]);
  expect(words(mixed)).toEqual(["out"]);
  expect(blockLines(mixed, { start: 0, end: mixed.indexOf("\n\nout") })).toEqual([
    { kind: "fence", lang: "", code: "~~~\n\ntext inside" }
  ]);

  // An unclosed fence runs to the end.
  expect(words("before\n\n~~~py\nx = 1")).toEqual(["before"]);
});

test("a lone or escaped star stays text, _marks_ style only at word edges, and tags draw nothing", async () => {
  const draw = (md: string) =>
    inlineSpans(md, 0, md.length, null).map((s) => [s.text, s.bold, s.italic]);
  expect(draw("2 * 3 = 6")).toEqual([["2 * 3 = 6", undefined, undefined]]);
  expect(draw("a \\*b\\* c")).toEqual([["a *b* c", undefined, undefined]]);
  expect(draw("_one_ and snake_case_name")).toEqual([
    ["one", undefined, true],
    [" and snake_case_name", undefined, undefined]
  ]);
  expect(draw("__bold__ x")).toEqual([
    ["bold", true, undefined],
    [" x", undefined, undefined]
  ]);
  expect(draw("a<br>b <span>c</span>")).toEqual([["a b c", undefined, undefined]]);
});

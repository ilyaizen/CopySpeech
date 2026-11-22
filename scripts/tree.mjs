// Writes a linux-style `tree -a --dirsfirst --noreport` listing to docs_internal/file-structure.txt.
// Replaces the old WSL one-liner. Names in IGNORE are skipped at every depth, like `tree -I`.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs_internal", "file-structure.txt");

const IGNORE = new Set(
  (
    "docs_internal .zcode .hermes node_modules .venv .next target .git Handy prompts skills " +
    ".vercel dist out gen .svelte-kit .obsidian ui build icons .agent .agents .claude .tauri " +
    ".ruff_cache __pycache__ .gemini .opencode .kilocode archive backups bun.lock openspec .planning"
  ).split(" ")
);

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function walk(dir, prefix, lines) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORE.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || byName(a, b));
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    lines.push(`${prefix}${last ? "└── " : "├── "}${e.name}`);
    if (e.isDirectory()) walk(join(dir, e.name), prefix + (last ? "    " : "│   "), lines);
  });
}

const lines = ["."];
walk(root, "", lines);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length - 1} entries -> ${out}`);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/file-index/route.ts", import.meta.url), "utf8");

test("file search queries the full server-side index and keeps file results", () => {
  assert.match(source, /new URLSearchParams\(\{ cwd, q: normalizedSearchQuery, filesOnly: "1" \}\)/);
  assert.match(source, /fetch\(`\/api\/file-index\?\$\{params\.toString\(\)\}`/);
  assert.match(routeSource, /filesOnly[\s\S]*cached\.entries\.filter\(\(entry\) => !entry\.isDir\)/);
});

test("file search results open in the existing viewer", () => {
  assert.match(source, /const fullPath = joinFilePath\(cwd, result\.path\)/);
  assert.match(source, /onOpenFile\(fullPath, getFileName\(result\.path\)\)/);
  assert.match(source, /onOpen=\{\(\) => openSearchResult\(result\)\}/);
});

test("file search replaces the tree and supports keyboard navigation", () => {
  assert.match(source, /\{searchActive && \(/);
  assert.match(source, /\{!searchActive && !changesCollapsed/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Escape"/);
});

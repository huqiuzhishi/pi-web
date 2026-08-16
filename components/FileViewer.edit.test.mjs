import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewerSource = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const editorSource = await readFile(new URL("./CodeEditor.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
const revertRouteSource = await readFile(new URL("../app/api/git/revert/route.ts", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("text files remain read-only until edit mode is enabled", () => {
  assert.match(viewerSource, /const \[editState, setEditState\]/);
  assert.match(viewerSource, /onClick=\{beginEditing\}/);
  assert.match(viewerSource, /isEditing \? \(\s*<CodeEditor/);
  assert.match(viewerSource, /disabled=\{!editState\.dirty \|\| saving\}/);
});

test("CodeMirror supports syntax modes, wrapping, and keyboard save", () => {
  assert.match(editorSource, /basicSetup/);
  assert.match(editorSource, /javascript\(\{ typescript: true, jsx: true \}\)/);
  assert.match(editorSource, /EditorView\.lineWrapping/);
  assert.match(editorSource, /key: "Mod-s"/);
});

test("saving uses an optimistic version and pauses live reads while editing", () => {
  assert.match(viewerSource, /expectedVersion: currentEditState\.baseVersion/);
  assert.match(viewerSource, /if \(editState\?\.active\) return/);
  assert.match(routeSource, /export async function PUT/);
  assert.match(routeSource, /writeTextFileIfVersionMatchesSync/);
  assert.match(routeSource, /!isFilePathAllowed[\s\S]*!isExistingFilePathAllowed/);
  assert.match(routeSource, /hasJsonContentType/);
});

test("dirty tabs survive switching and warn before destructive exits", () => {
  assert.match(shellSource, /hasDirtyFileTabs/);
  assert.match(shellSource, /beforeunload/);
  assert.match(shellSource, /files\.closeDirtyConfirm/);
  assert.match(viewerSource, /onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\)/);
});

test("tracked file changes can be reverted after explicit confirmation", () => {
  assert.match(viewerSource, /gitDiff\.status !== "untracked"/);
  assert.match(viewerSource, /window\.confirm\(confirmation\)/);
  assert.match(viewerSource, /fetch\("\/api\/git\/revert"/);
  assert.match(revertRouteSource, /isApiRequestAllowed\(request\)/);
  assert.match(revertRouteSource, /hasJsonContentType\(request\)/);
  assert.match(revertRouteSource, /isExistingFilePathAllowed\(cwd, allowedRoots\)/);
  assert.match(revertRouteSource, /revertGitFile\(cwd, filePath\)/);
  assert.match(shellSource, /onReverted=\{handleFileReverted\}/);
});

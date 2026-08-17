import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  const end = source.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(block, /activeFileTab\?\.filePath \? \(/);
  assert.doesNotMatch(block, /fileTabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{activeFileTab\.id\}:\$\{activeFileTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /initialState=\{activeFileTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*activeFileTab\.id,\s*activeFileTab\.viewerRevision \?\? 0,/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(fileContentBlock(), /watchEnabled=\{rightPanelOpen\}/);
});

test("file tabs and panel visibility are scoped to the active session or draft", () => {
  assert.match(source, /filePanelScopeKey = getFilePanelScopeKey\(selectedSession\?\.id \?\? null, newSessionDraftKey\)/);
  assert.match(source, /filePanelState = getFilePanelState\(filePanelStates, filePanelScopeKey\)/);
  assert.match(source, /const fileTabs = filePanelState\.tabs/);
  assert.match(source, /const activeFileTabId = filePanelState\.activeTabId/);
  assert.match(source, /const rightPanelOpen = filePanelState\.open/);
});

test("same-path viewers mount independently in different session scopes", () => {
  const start = source.indexOf("  const handleOpenFile = useCallback");
  const end = source.indexOf("  const handleOpenLinkedFile", start);
  assert.notEqual(start, -1, "open-file handler not found");
  assert.notEqual(end, -1, "end of open-file handler not found");

  const block = source.slice(start, end);
  assert.match(block, /`file:\$\{filePanelScopeKey\}:\$\{filePath\}`/);
});

test("a fresh draft transfers its file panel state to the created session", () => {
  const start = source.indexOf("  const handleSessionCreated = useCallback");
  const end = source.indexOf("  const deliverSessionNotification", start);
  assert.notEqual(start, -1, "session-created handler not found");
  assert.notEqual(end, -1, "end of session-created handler not found");

  const block = source.slice(start, end);
  assert.match(block, /moveFilePanelState\(/);
  assert.match(block, /getFilePanelScopeKey\(null, sourceDraftKey\)/);
  assert.match(block, /getFilePanelScopeKey\(session\.id, null\)/);
});

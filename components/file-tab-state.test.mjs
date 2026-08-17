import assert from "node:assert/strict";
import test from "node:test";

import {
  getFilePanelScopeKey,
  getFilePanelState,
  moveFilePanelState,
  openFileTab,
  saveFileViewerState,
  updateFilePanelState,
} from "./file-tab-state.ts";

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("file panel scope keys separate sessions and fresh drafts", () => {
  assert.equal(getFilePanelScopeKey("session-1", "ignored-draft"), "session:session-1");
  assert.equal(getFilePanelScopeKey(null, "new:draft-1:/repo"), "draft:new:draft-1:/repo");
  assert.equal(getFilePanelScopeKey(null, null), "unscoped");
});

test("file panel updates affect only one scope", () => {
  const sessionOne = getFilePanelScopeKey("session-1", null);
  const sessionTwo = getFilePanelScopeKey("session-2", null);
  const initial = updateFilePanelState({}, sessionOne, () => ({
    tabs: [tabA],
    activeTabId: tabA.id,
    open: true,
  }));
  const updated = updateFilePanelState(initial, sessionTwo, () => ({
    tabs: [tabB],
    activeTabId: tabB.id,
    open: false,
  }));

  assert.deepEqual(getFilePanelState(updated, sessionOne), {
    tabs: [tabA],
    activeTabId: tabA.id,
    open: true,
  });
  assert.deepEqual(getFilePanelState(updated, sessionTwo), {
    tabs: [tabB],
    activeTabId: tabB.id,
    open: false,
  });
});

test("a promoted draft keeps its file panel under the real session id", () => {
  const draft = getFilePanelScopeKey(null, "new:draft-1:/repo");
  const session = getFilePanelScopeKey("session-1", null);
  const draftState = { tabs: [tabA], activeTabId: tabA.id, open: true };
  const moved = moveFilePanelState({ [draft]: draftState }, draft, session);

  assert.strictEqual(getFilePanelState(moved, session), draftState);
  assert.deepEqual(getFilePanelState(moved, draft), {
    tabs: [],
    activeTabId: null,
    open: false,
  });
});

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [tabA, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});

test("an explicit diff activation preserves an unsaved editor buffer", () => {
  const edit = {
    active: true,
    draft: "const answer = 42;\n",
    baseContent: "const answer = 1;\n",
    baseVersion: { mtimeMs: 1, size: 18, sha256: "a".repeat(64) },
    dirty: true,
  };
  const tab = { ...tabA, viewerState: { ...tabA.viewerState, edit } };
  const [reopened] = openFileTab([tab], { ...openA, modeHint: "diff" });

  assert.strictEqual(reopened.viewerState.edit, edit);
  assert.equal(reopened.viewerState.displayMode, "diff");
});

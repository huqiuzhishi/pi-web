import type { FileViewerState } from "@/lib/file-viewer-state";
import type { Tab } from "./TabBar";

export interface FilePanelState {
  tabs: Tab[];
  activeTabId: string | null;
  open: boolean;
}

export type FilePanelStates = Record<string, FilePanelState>;

const EMPTY_FILE_PANEL_STATE: FilePanelState = {
  tabs: [],
  activeTabId: null,
  open: false,
};

const FILE_PANEL_STORAGE_KEY = "pi-web:file-panels";
const FILE_PANEL_STORAGE_VERSION = 1;
const MAX_PERSISTED_FILE_PANEL_SCOPES = 50;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDisplayMode(value: unknown): value is NonNullable<Tab["initialDisplayMode"]> {
  return value === "source" || value === "preview" || value === "diff";
}

function restoreTab(value: unknown): Tab | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.label !== "string" || typeof value.filePath !== "string") {
    return null;
  }

  const tab: Tab = {
    id: value.id,
    label: value.label,
    filePath: value.filePath,
  };
  if (typeof value.sourceSessionId === "string" || value.sourceSessionId === null) {
    tab.sourceSessionId = value.sourceSessionId;
  }
  if (isDisplayMode(value.initialDisplayMode)) tab.initialDisplayMode = value.initialDisplayMode;
  if (Number.isSafeInteger(value.viewerRevision) && (value.viewerRevision as number) >= 0) {
    tab.viewerRevision = value.viewerRevision as number;
  }

  if (isRecord(value.viewerState)) {
    const state = value.viewerState;
    if (
      isDisplayMode(state.displayMode)
      && typeof state.wrapLines === "boolean"
      && typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop)
      && typeof state.scrollLeft === "number" && Number.isFinite(state.scrollLeft)
    ) {
      tab.viewerState = {
        displayMode: state.displayMode,
        wrapLines: state.wrapLines,
        scrollTop: Math.max(0, state.scrollTop),
        scrollLeft: Math.max(0, state.scrollLeft),
      };
    }
  }
  return tab;
}

function restorePanel(value: unknown): FilePanelState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs) || typeof value.open !== "boolean") return null;
  const tabs = value.tabs.map(restoreTab).filter((tab): tab is Tab => tab !== null);
  const requestedActiveTabId = typeof value.activeTabId === "string" ? value.activeTabId : null;
  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.id === requestedActiveTabId)
      ? requestedActiveTabId
      : (tabs.at(-1)?.id ?? null),
    open: value.open,
  };
}

/** Restore file tabs and lightweight viewer state after a browser refresh. */
export function loadFilePanelStates(
  storage: StorageLike | null = getBrowserStorage(),
): FilePanelStates {
  if (!storage) return {};
  try {
    const raw = storage.getItem(FILE_PANEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== FILE_PANEL_STORAGE_VERSION || !isRecord(parsed.states)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.states)
        .map(([scopeKey, value]) => [scopeKey, restorePanel(value)] as const)
        .filter((entry): entry is readonly [string, FilePanelState] => entry[1] !== null),
    );
  } catch {
    return {};
  }
}

/**
 * Persist open file views. Editor buffers are intentionally excluded: they can
 * be arbitrarily large and should not turn localStorage into a second file store.
 */
export function persistFilePanelStates(
  states: FilePanelStates,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const entries = Object.entries(states)
      .filter(([, state]) => state.open || state.tabs.length > 0)
      .slice(-MAX_PERSISTED_FILE_PANEL_SCOPES)
      .map(([scopeKey, state]) => [scopeKey, {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          ...(tab.viewerState ? {
            viewerState: {
              displayMode: tab.viewerState.displayMode,
              wrapLines: tab.viewerState.wrapLines,
              scrollTop: tab.viewerState.scrollTop,
              scrollLeft: tab.viewerState.scrollLeft,
            },
          } : {}),
        })),
      }]);
    if (entries.length === 0) {
      storage.removeItem(FILE_PANEL_STORAGE_KEY);
      return;
    }
    storage.setItem(FILE_PANEL_STORAGE_KEY, JSON.stringify({
      version: FILE_PANEL_STORAGE_VERSION,
      states: Object.fromEntries(entries),
    }));
  } catch {
    // Browser storage is best-effort (private mode, quota, or disabled storage).
  }
}

export function getFilePanelScopeKey(
  sessionId: string | null,
  newSessionDraftKey: string | null,
): string {
  if (sessionId) return `session:${sessionId}`;
  if (newSessionDraftKey) return `draft:${newSessionDraftKey}`;
  return "unscoped";
}

export function getFilePanelState(
  states: FilePanelStates,
  scopeKey: string,
): FilePanelState {
  return states[scopeKey] ?? EMPTY_FILE_PANEL_STATE;
}

export function updateFilePanelState(
  states: FilePanelStates,
  scopeKey: string,
  update: (state: FilePanelState) => FilePanelState,
): FilePanelStates {
  const current = getFilePanelState(states, scopeKey);
  const next = update(current);
  if (next === current) return states;
  return { ...states, [scopeKey]: next };
}

export function moveFilePanelState(
  states: FilePanelStates,
  fromScopeKey: string,
  toScopeKey: string,
): FilePanelStates {
  if (fromScopeKey === toScopeKey || !states[fromScopeKey]) return states;
  const next = { ...states, [toScopeKey]: states[fromScopeKey] };
  delete next[fromScopeKey];
  return next;
}

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
        ...(tab.viewerState?.edit ? { edit: tab.viewerState.edit } : {}),
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface FileViewerEditState {
  active: boolean;
  draft: string;
  baseContent: string;
  baseVersion: FileVersion;
  dirty: boolean;
}

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
  edit?: FileViewerEditState;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}

const STORAGE_KEY = "pi-web:terminal-by-workspace";
const MAX_REMEMBERED_TERMINALS = 24;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    // A terminal belongs to one browser tab. sessionStorage survives reloads
    // without making two independently open tabs share input sequence numbers.
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readMap(storage: StorageLike): Record<string, string> {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[1] === "string" && entry[1].length > 0
      )),
    );
  } catch {
    return {};
  }
}

export function getRememberedTerminalId(
  workspace: string,
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  if (!storage) return null;
  try {
    return readMap(storage)[workspace] ?? null;
  } catch {
    return null;
  }
}

export function rememberTerminalId(
  workspace: string,
  terminalId: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    // Reinsert the workspace so object order tracks recent use for pruning.
    delete map[workspace];
    map[workspace] = terminalId;
    const recent = Object.fromEntries(Object.entries(map).slice(-MAX_REMEMBERED_TERMINALS));
    storage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Browser storage is best-effort.
  }
}

export function forgetRememberedTerminal(
  workspace: string,
  terminalId?: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const map = readMap(storage);
    if (!(workspace in map) || (terminalId !== undefined && map[workspace] !== terminalId)) return;
    delete map[workspace];
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Browser storage is best-effort.
  }
}

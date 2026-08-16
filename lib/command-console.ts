import { randomUUID } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import { sanitizeProjectCommandEnvironment } from "./project-command-env";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_EVENT_CHARS = 64 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const MAX_INPUT_SEQUENCE_GAP = 1_000;
const MAX_SESSIONS = 12;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 24;
const STORE_VERSION = 2;

function ensureNodePtySpawnHelperIsExecutable(): void {
  if (process.platform === "win32") return;
  const helper = path.join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
  } catch {
    // Source builds do not use the prebuilt helper. Let node-pty report any
    // genuine spawn error when the terminal starts.
  }
}

ensureNodePtySpawnHelperIsExecutable();

export type CommandConsoleEvent =
  | { type: "ready"; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "clear" }
  | { type: "exit"; exitCode: number; signal?: number };

export type CommandConsoleWireEvent = CommandConsoleEvent | {
  type: "snapshot";
  events: CommandConsoleEvent[];
  alive: boolean;
  cols: number;
  rows: number;
  nextInputSequence: number;
};

type Listener = (event: CommandConsoleWireEvent) => void;

function clampDimension(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function terminalEnvironment(): Record<string, string> {
  const sanitized = sanitizeProjectCommandEnvironment(process.env);
  const environment = Object.fromEntries(
    Object.entries(sanitized).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  environment.PI_WEB_TERMINAL = "1";
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  return environment;
}

function resolveShell(): { file: string; args: string[] } {
  const configured = process.env.PI_WEB_TERMINAL_SHELL?.trim()
    || process.env.PI_WEB_BASH_PATH?.trim();
  if (configured) return { file: configured, args: process.platform === "win32" ? [] : ["-l"] };
  if (process.platform === "win32") {
    return { file: process.env.ComSpec?.trim() || "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL?.trim() || "bash", args: ["-l"] };
}

export class CommandConsoleSession {
  readonly id = randomUUID();
  readonly initialCwd: string;
  lastUsedAt = Date.now();

  private readonly terminal: pty.IPty;
  private readonly listeners = new Set<Listener>();
  private readonly history: CommandConsoleEvent[] = [];
  private readonly pendingInput = new Map<number, string>();
  private historyBytes = 0;
  private pendingInputBytes = 0;
  private nextInputSequence = 1;
  private alive = true;
  private cols: number;
  private rows: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string, dimensions?: { cols?: number; rows?: number }) {
    this.initialCwd = cwd;
    this.cols = clampDimension(dimensions?.cols, DEFAULT_COLUMNS, 2, 500);
    this.rows = clampDimension(dimensions?.rows, DEFAULT_ROWS, 2, 300);
    const shell = resolveShell();
    this.terminal = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: terminalEnvironment(),
    });

    this.terminal.onData((data) => {
      if (data) this.emit({ type: "output", data });
      this.touch();
    });
    this.terminal.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.pendingInput.clear();
      this.pendingInputBytes = 0;
      this.emit({ type: "exit", exitCode, ...(signal === undefined ? {} : { signal }) });
      this.scheduleIdleCleanup(60_000);
    });
    this.emit({ type: "ready", cols: this.cols, rows: this.rows });
    this.touch();
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get isInUse(): boolean {
    return this.listeners.size > 0;
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  subscribe(listener: Listener): () => void {
    this.touch();
    this.listeners.add(listener);
    listener({
      type: "snapshot",
      events: [...this.history],
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      nextInputSequence: this.nextInputSequence,
    });
    return () => this.listeners.delete(listener);
  }

  writeInput(sequence: number, data: string): void {
    this.touch();
    if (!this.alive) throw new Error("The terminal has exited");
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid input sequence");
    if (!data) return;
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) throw new Error("Terminal input is too large");
    if (sequence < this.nextInputSequence) return;
    if (sequence - this.nextInputSequence > MAX_INPUT_SEQUENCE_GAP) throw new Error("Input sequence is too far ahead");
    if (this.pendingInput.has(sequence)) return;

    const byteLength = Buffer.byteLength(data, "utf8");
    if (this.pendingInputBytes + byteLength > MAX_PENDING_INPUT_BYTES) {
      throw new Error("Too much terminal input is pending");
    }
    this.pendingInput.set(sequence, data);
    this.pendingInputBytes += byteLength;

    while (true) {
      const next = this.pendingInput.get(this.nextInputSequence);
      if (next === undefined) break;
      this.pendingInput.delete(this.nextInputSequence);
      this.pendingInputBytes -= Buffer.byteLength(next, "utf8");
      this.terminal.write(next);
      this.nextInputSequence += 1;
    }
  }

  resize(cols: number, rows: number): void {
    this.touch();
    if (!this.alive) return;
    const nextCols = clampDimension(cols, this.cols, 2, 500);
    const nextRows = clampDimension(rows, this.rows, 2, 300);
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.terminal.resize(nextCols, nextRows);
  }

  clearHistory(): void {
    this.history.length = 0;
    this.historyBytes = 0;
    this.emit({ type: "clear" });
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.listeners.clear();
    this.pendingInput.clear();
    this.pendingInputBytes = 0;
    if (!this.alive) return;
    this.alive = false;
    try {
      this.terminal.kill();
    } catch {
      // The PTY has already exited.
    }
  }

  private touch(): void {
    this.lastUsedAt = Date.now();
    this.scheduleIdleCleanup(IDLE_TIMEOUT_MS);
  }

  private scheduleIdleCleanup(delay: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isInUse) {
        this.scheduleIdleCleanup(IDLE_TIMEOUT_MS);
        return;
      }
      deleteCommandConsoleSession(this.id);
    }, delay);
    this.idleTimer.unref();
  }

  private emit(event: CommandConsoleEvent): void {
    const previous = this.history.at(-1);
    if (
      event.type === "output"
      && previous?.type === "output"
      && previous.data.length + event.data.length <= MAX_HISTORY_EVENT_CHARS
    ) {
      this.historyBytes -= JSON.stringify(previous).length;
      previous.data += event.data;
      this.historyBytes += JSON.stringify(previous).length;
    } else {
      this.history.push(event);
      this.historyBytes += JSON.stringify(event).length;
    }
    while (this.historyBytes > MAX_HISTORY_BYTES && this.history.length > 1) {
      const removed = this.history.shift();
      if (removed) this.historyBytes -= JSON.stringify(removed).length;
    }
    for (const listener of this.listeners) listener(event);
  }
}

type CommandConsoleStore = {
  version: number;
  sessions: Map<string, CommandConsoleSession>;
  cleanupInstalled: boolean;
};

declare global {
  var __piCommandConsoleStore: CommandConsoleStore | undefined;
}

function getStore(): CommandConsoleStore {
  const existing = globalThis.__piCommandConsoleStore;
  if (existing && existing.version !== STORE_VERSION) {
    for (const session of existing.sessions.values()) session.close();
    globalThis.__piCommandConsoleStore = undefined;
  }
  if (!globalThis.__piCommandConsoleStore) {
    globalThis.__piCommandConsoleStore = { version: STORE_VERSION, sessions: new Map(), cleanupInstalled: false };
  }
  const store = globalThis.__piCommandConsoleStore;
  if (!store.cleanupInstalled) {
    store.cleanupInstalled = true;
    process.once("exit", () => {
      for (const session of store.sessions.values()) session.close();
      store.sessions.clear();
    });
  }
  return store;
}

export async function createCommandConsoleSession(
  cwd: string,
  dimensions?: { cols?: number; rows?: number },
): Promise<CommandConsoleSession> {
  const store = getStore();
  if (store.sessions.size >= MAX_SESSIONS) {
    const idle = [...store.sessions.values()]
      .filter((session) => !session.isInUse)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) throw new Error("Too many terminals are running");
    deleteCommandConsoleSession(idle.id);
  }

  const session = new CommandConsoleSession(path.resolve(cwd), dimensions);
  store.sessions.set(session.id, session);
  return session;
}

export function getCommandConsoleSession(id: string): CommandConsoleSession | undefined {
  return getStore().sessions.get(id);
}

export function deleteCommandConsoleSession(id: string): boolean {
  const store = getStore();
  const session = store.sessions.get(id);
  if (!session) return false;
  store.sessions.delete(id);
  session.close();
  return true;
}

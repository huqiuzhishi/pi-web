import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeProjectCommandEnvironment } from "./project-command-env";

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_LENGTH = 100_000;
const MAX_SESSIONS = 12;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type CommandConsoleEvent =
  | { type: "ready"; cwd: string }
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "command_start"; sequence: number; command: string; cwd: string }
  | { type: "command_end"; sequence: number; status: number; cwd: string }
  | { type: "clear" }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export type CommandConsoleWireEvent = CommandConsoleEvent | {
  type: "snapshot";
  events: CommandConsoleEvent[];
  cwd: string;
  busy: boolean;
  alive: boolean;
};

type Listener = (event: CommandConsoleWireEvent) => void;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have already exited or may not own a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process has already exited.
  }
}

export class CommandConsoleSession {
  readonly id = randomUUID();
  readonly initialCwd: string;
  lastUsedAt = Date.now();

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly markerToken = randomUUID();
  private readonly markerPrefix: string;
  private readonly tempDirectory: string;
  private readonly listeners = new Set<Listener>();
  private readonly history: CommandConsoleEvent[] = [];
  private readonly commandFiles = new Map<number, string>();
  private readonly readyPromise: Promise<void>;
  private historyBytes = 0;
  private stdoutBuffer = "";
  private currentCwd: string;
  private sequence = 0;
  private activeSequence: number | null = null;
  private alive = true;
  private spawned = false;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string) {
    this.initialCwd = cwd;
    this.currentCwd = cwd;
    this.markerPrefix = `\x1e${this.markerToken}:`;
    this.tempDirectory = path.join(tmpdir(), `pi-web-console-${this.id}`);

    const environment = sanitizeProjectCommandEnvironment(process.env);
    environment.PI_WEB_CONSOLE = "1";
    environment.TERM ??= "dumb";

    const shellPath = process.env.PI_WEB_BASH_PATH?.trim() || "bash";
    this.child = spawn(shellPath, ["--noprofile", "--norc"], {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.readyPromise = new Promise((resolve, reject) => {
      this.child.once("spawn", () => {
        this.spawned = true;
        this.child.stdin.write("trap ':' INT\n");
        this.emit({ type: "ready", cwd: this.currentCwd });
        this.touch();
        resolve();
      });
      this.child.once("error", (error) => {
        this.alive = false;
        this.emit({ type: "error", message: error.message });
        if (!this.spawned) reject(error);
      });
    });

    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      if (chunk) this.emit({ type: "output", stream: "stderr", data: chunk });
    });
    this.child.once("close", (code, signal) => {
      this.alive = false;
      if (this.stdoutBuffer) {
        this.emit({ type: "output", stream: "stdout", data: this.stdoutBuffer });
        this.stdoutBuffer = "";
      }
      this.activeSequence = null;
      void this.removeCommandFiles();
      this.emit({ type: "exit", code, signal });
      this.scheduleIdleCleanup(60_000);
    });
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get isBusy(): boolean {
    return this.activeSequence !== null;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get isInUse(): boolean {
    return this.isBusy || this.listeners.size > 0;
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
    await mkdir(this.tempDirectory, { recursive: true, mode: 0o700 });
  }

  subscribe(listener: Listener): () => void {
    this.touch();
    this.listeners.add(listener);
    listener({
      type: "snapshot",
      events: [...this.history],
      cwd: this.currentCwd,
      busy: this.isBusy,
      alive: this.alive,
    });
    return () => this.listeners.delete(listener);
  }

  async runCommand(command: string): Promise<number> {
    this.touch();
    if (!this.alive) throw new Error("The command console has exited");
    if (this.isBusy) throw new Error("A command is already running");
    if (!command.trim()) throw new Error("Command is required");
    if (command.length > MAX_COMMAND_LENGTH) throw new Error("Command is too long");

    await this.waitUntilReady();
    const sequence = ++this.sequence;
    const commandFile = path.join(this.tempDirectory, `${sequence}.sh`);
    await writeFile(commandFile, `${command}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    this.commandFiles.set(sequence, commandFile);
    this.activeSequence = sequence;
    this.emit({ type: "command_start", sequence, command, cwd: this.currentCwd });

    const variableSuffix = this.markerToken.replaceAll("-", "");
    const statusVariable = `__pi_web_${variableSuffix}_status`;
    const cwdVariable = `__pi_web_${variableSuffix}_cwd`;
    const protocol = [
      `. ${shellQuote(commandFile)}`,
      `${statusVariable}=$?`,
      `${cwdVariable}="$PWD"`,
      `printf '\\036${this.markerToken}:%s:%s\\035%s\\034\\n' '${sequence}' "$${statusVariable}" "$${cwdVariable}"`,
      "",
    ].join("\n");

    try {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(protocol, (error) => error ? reject(error) : resolve());
      });
      return sequence;
    } catch (error) {
      if (this.activeSequence === sequence) this.activeSequence = null;
      this.commandFiles.delete(sequence);
      await unlink(commandFile).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", message: `Failed to send command to Bash: ${message}` });
      throw error;
    }
  }

  interrupt(): void {
    this.touch();
    if (!this.alive || !this.isBusy) return;
    killProcessGroup(this.child, "SIGINT");
    // The POST that starts a command returns once its protocol is written. A
    // very fast Stop click can arrive just before Bash begins the sourced
    // script, so repeat SIGINT once if the command is still active.
    const retry = setTimeout(() => {
      if (this.alive && this.isBusy) killProcessGroup(this.child, "SIGINT");
    }, 75);
    retry.unref();
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
    void this.removeCommandFiles();
    if (!this.alive) return;
    this.alive = false;
    this.child.stdin.end();
    killProcessGroup(this.child, "SIGTERM");
    const forceTimer = setTimeout(() => killProcessGroup(this.child, "SIGKILL"), 2_000);
    forceTimer.unref();
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
    this.history.push(event);
    this.historyBytes += JSON.stringify(event).length;
    while (this.historyBytes > MAX_HISTORY_BYTES && this.history.length > 1) {
      const removed = this.history.shift();
      if (removed) this.historyBytes -= JSON.stringify(removed).length;
    }
    for (const listener of this.listeners) listener(event);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer) {
      const markerStart = this.stdoutBuffer.indexOf(this.markerPrefix);
      if (markerStart < 0) {
        const safeLength = this.stdoutBuffer.length - this.markerPrefix.length + 1;
        if (safeLength <= 0) return;
        this.emit({ type: "output", stream: "stdout", data: this.stdoutBuffer.slice(0, safeLength) });
        this.stdoutBuffer = this.stdoutBuffer.slice(safeLength);
        return;
      }

      if (markerStart > 0) {
        this.emit({ type: "output", stream: "stdout", data: this.stdoutBuffer.slice(0, markerStart) });
      }
      const markerEnd = this.stdoutBuffer.indexOf("\x1c\n", markerStart + this.markerPrefix.length);
      if (markerEnd < 0) {
        this.stdoutBuffer = this.stdoutBuffer.slice(markerStart);
        return;
      }

      const payload = this.stdoutBuffer.slice(markerStart + this.markerPrefix.length, markerEnd);
      this.stdoutBuffer = this.stdoutBuffer.slice(markerEnd + 2);
      const match = /^(\d+):(-?\d+)\x1d([\s\S]*)$/.exec(payload);
      if (!match) continue;

      const sequence = Number(match[1]);
      const status = Number(match[2]);
      const cwd = match[3] || this.currentCwd;
      this.currentCwd = cwd;
      if (this.activeSequence === sequence) this.activeSequence = null;
      const commandFile = this.commandFiles.get(sequence);
      if (commandFile) {
        this.commandFiles.delete(sequence);
        void unlink(commandFile).catch(() => {});
      }
      this.emit({ type: "command_end", sequence, status, cwd });
      this.touch();
    }
  }

  private async removeCommandFiles(): Promise<void> {
    this.commandFiles.clear();
    await rm(this.tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

type CommandConsoleStore = {
  sessions: Map<string, CommandConsoleSession>;
  cleanupInstalled: boolean;
};

declare global {
  var __piCommandConsoleStore: CommandConsoleStore | undefined;
}

function getStore(): CommandConsoleStore {
  if (!globalThis.__piCommandConsoleStore) {
    globalThis.__piCommandConsoleStore = { sessions: new Map(), cleanupInstalled: false };
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

export async function createCommandConsoleSession(cwd: string): Promise<CommandConsoleSession> {
  const store = getStore();
  if (store.sessions.size >= MAX_SESSIONS) {
    const idle = [...store.sessions.values()]
      .filter((session) => !session.isInUse)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) throw new Error("Too many command consoles are running");
    deleteCommandConsoleSession(idle.id);
  }

  const session = new CommandConsoleSession(cwd);
  store.sessions.set(session.id, session);
  try {
    await session.waitUntilReady();
    return session;
  } catch (error) {
    deleteCommandConsoleSession(session.id);
    throw error;
  }
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

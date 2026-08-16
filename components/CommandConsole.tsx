"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { CommandConsoleEvent, CommandConsoleWireEvent } from "@/lib/command-console";
import { useI18n } from "@/hooks/useI18n";

const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 140;
const INPUT_FLUSH_DELAY_MS = 8;
const INPUT_RETRY_DELAY_MS = 100;
const MAX_INPUT_CHARS_PER_REQUEST = 60_000;
const TERMINAL_FONT_FAMILY = '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", var(--font-mono)';

function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--bg").trim(),
    foreground: styles.getPropertyValue("--text").trim(),
    cursor: styles.getPropertyValue("--text").trim(),
    cursorAccent: styles.getPropertyValue("--bg").trim(),
    selectionBackground: styles.getPropertyValue("--bg-selected").trim(),
    black: "#111827",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#06b6d4",
    white: "#d1d5db",
    brightBlack: "#6b7280",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: "#f9fafb",
  };
}

function clearTerminal(terminal: Terminal): void {
  terminal.clear();
  terminal.write("\x1b[2J\x1b[H");
}

function splitTerminalInput(data: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(data.length, start + MAX_INPUT_CHARS_PER_REQUEST);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end -= 1;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

function replayEvent(terminal: Terminal, event: CommandConsoleEvent): boolean {
  switch (event.type) {
    case "output":
      terminal.write(event.data);
      return true;
    case "clear":
      clearTerminal(terminal);
      return true;
    case "exit":
      terminal.write(`\r\n[terminal exited: ${event.exitCode}${event.signal === undefined ? "" : `, signal ${event.signal}`}]\r\n`);
      return false;
    case "ready":
      return true;
  }
}

interface Props {
  cwd: string | null;
  open: boolean;
  onClose: () => void;
}

export function CommandConsole({ cwd, open }: Props) {
  const { t } = useI18n();
  const [terminalReady, setTerminalReady] = useState(false);
  const [panelHeight, setPanelHeight] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_HEIGHT;
    const stored = Number(window.localStorage.getItem("pi-command-console-height"));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
  });
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionRootRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const creatingRef = useRef(false);
  const inputSequenceRef = useRef(1);
  const canSendInputRef = useRef(false);
  const inputBufferRef = useRef("");
  const inputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputSendChainRef = useRef<Promise<void>>(Promise.resolve());
  const panelHeightRef = useRef(panelHeight);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const showTransportError = useCallback((message: string) => {
    canSendInputRef.current = false;
    terminalRef.current?.write(`\r\n\x1b[31m[terminal connection error] ${message}\x1b[0m\r\n`);
  }, []);

  const postTerminalAction = useCallback(async (
    body: Record<string, unknown>,
    retry = false,
    targetId?: string,
  ) => {
    const id = targetId ?? sessionIdRef.current;
    if (!id) throw new Error("Terminal is not connected");
    const send = () => fetch(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, INPUT_RETRY_DELAY_MS));
      response = await send();
    }
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  }, []);

  const flushInput = useCallback(() => {
    inputFlushTimerRef.current = null;
    const data = inputBufferRef.current;
    inputBufferRef.current = "";
    const targetId = sessionIdRef.current;
    if (!data || !targetId) return;
    const generation = generationRef.current;
    const inputs = splitTerminalInput(data).map((chunk) => ({
      data: chunk,
      sequence: inputSequenceRef.current++,
    }));
    inputSendChainRef.current = inputSendChainRef.current
      .then(async () => {
        if (generation !== generationRef.current || !canSendInputRef.current) return;
        for (const input of inputs) {
          await postTerminalAction({ action: "input", ...input }, true, targetId);
        }
      })
      .catch((error) => {
        if (generation === generationRef.current) {
          showTransportError(error instanceof Error ? error.message : String(error));
        }
      });
  }, [postTerminalAction, showTransportError]);

  const queueInput = useCallback((data: string) => {
    if (!data || !canSendInputRef.current) return;
    inputBufferRef.current += data;
    if (inputFlushTimerRef.current === null) {
      inputFlushTimerRef.current = setTimeout(flushInput, INPUT_FLUSH_DELAY_MS);
    }
  }, [flushInput]);

  const fitTerminal = useCallback(() => {
    if (!open || !terminalRef.current || !fitAddonRef.current || !terminalHostRef.current) return;
    if (terminalHostRef.current.clientWidth === 0 || terminalHostRef.current.clientHeight === 0) return;
    try {
      fitAddonRef.current.fit();
    } catch {
      // The panel can become hidden between measuring and fitting.
    }
  }, [open]);

  const closeTransport = useCallback((deleteRemote: boolean) => {
    generationRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (inputFlushTimerRef.current !== null) clearTimeout(inputFlushTimerRef.current);
    inputFlushTimerRef.current = null;
    inputBufferRef.current = "";
    inputSendChainRef.current = Promise.resolve();
    inputSequenceRef.current = 1;
    canSendInputRef.current = false;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    sessionRootRef.current = null;
    creatingRef.current = false;
    if (deleteRemote && id) {
      void fetch(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
  }, []);

  const handleWireEvent = useCallback((event: CommandConsoleWireEvent) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (event.type === "snapshot") {
      terminal.reset();
      terminal.options.theme = terminalTheme();
      let snapshotAlive = event.alive;
      for (const historicalEvent of event.events) {
        snapshotAlive = replayEvent(terminal, historicalEvent) && snapshotAlive;
      }
      inputSequenceRef.current = Math.max(inputSequenceRef.current, event.nextInputSequence);
      canSendInputRef.current = snapshotAlive;
      terminal.options.disableStdin = !snapshotAlive;
      requestAnimationFrame(fitTerminal);
      return;
    }
    const nextAlive = replayEvent(terminal, event);
    if (!nextAlive) {
      canSendInputRef.current = false;
      terminal.options.disableStdin = true;
    }
  }, [fitTerminal]);

  const startConsole = useCallback(async (root: string) => {
    if (creatingRef.current || !terminalRef.current) return;
    creatingRef.current = true;
    const generation = ++generationRef.current;
    canSendInputRef.current = false;
    terminalRef.current.reset();
    terminalRef.current.options.disableStdin = true;
    fitTerminal();
    const dimensions = {
      cols: terminalRef.current.cols,
      rows: terminalRef.current.rows,
    };
    try {
      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root, ...dimensions }),
      });
      const data = await response.json() as { id?: string; cwd?: string; error?: string };
      if (!response.ok || !data.id || !data.cwd) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      if (generation !== generationRef.current) {
        void fetch(`/api/terminal/${encodeURIComponent(data.id)}`, { method: "DELETE", keepalive: true });
        return;
      }

      sessionIdRef.current = data.id;
      sessionRootRef.current = root;
      const source = new EventSource(`/api/terminal/${encodeURIComponent(data.id)}/events`);
      eventSourceRef.current = source;
      source.onmessage = (message) => {
        if (generation !== generationRef.current) return;
        try {
          handleWireEvent(JSON.parse(message.data) as CommandConsoleWireEvent);
        } catch {
          // Ignore malformed transport events and keep the terminal connected.
        }
      };
    } catch (error) {
      if (generation !== generationRef.current) return;
      showTransportError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) creatingRef.current = false;
    }
  }, [fitTerminal, handleWireEvent, showTransportError]);

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | null = null;
    const disposables: Array<{ dispose(): void }> = [];
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, fit]) => {
      if (disposed || !terminalHostRef.current) return;
      const terminalStyles = getComputedStyle(terminalHostRef.current);
      terminal = new xterm.Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: true,
        fontFamily: terminalStyles.fontFamily,
        fontSize: Number.parseFloat(terminalStyles.fontSize) || 12,
        lineHeight: 1.15,
        scrollback: 10_000,
        theme: terminalTheme(),
      });
      const fitAddon = new fit.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalHostRef.current);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      disposables.push(terminal.onData(queueInput));
      disposables.push(terminal.onBinary(queueInput));
      disposables.push(terminal.onResize(({ cols, rows }) => {
        if (!sessionIdRef.current) return;
        void postTerminalAction({ action: "resize", cols, rows }).catch(() => {});
      }));
      setTerminalReady(true);
    }).catch((error) => {
      if (!disposed) showTransportError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      disposed = true;
      setTerminalReady(false);
      for (const disposable of disposables) disposable.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [postTerminalAction, queueInput, showTransportError]);

  useEffect(() => {
    if (sessionIdRef.current && sessionRootRef.current !== cwd) {
      closeTransport(true);
      terminalRef.current?.reset();
    }
    if (open && cwd && terminalReady && !sessionIdRef.current && !creatingRef.current) {
      void startConsole(cwd);
    }
  }, [closeTransport, cwd, open, startConsole, terminalReady]);

  useEffect(() => () => closeTransport(true), [closeTransport]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host || !terminalReady) return;
    const observer = new ResizeObserver(() => requestAnimationFrame(fitTerminal));
    observer.observe(host);
    return () => observer.disconnect();
  }, [fitTerminal, terminalReady]);

  useEffect(() => {
    if (!open || !terminalReady) return;
    requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });
  }, [fitTerminal, open, panelHeight, terminalReady]);

  useEffect(() => {
    if (!terminalReady) return;
    const observer = new MutationObserver(() => {
      if (terminalRef.current) terminalRef.current.options.theme = terminalTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [terminalReady]);

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeRef.current = { startY: event.clientY, startHeight: panelHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight * 0.7);
    const nextHeight = Math.max(MIN_HEIGHT, Math.min(maxHeight, resize.startHeight + resize.startY - event.clientY));
    panelHeightRef.current = nextHeight;
    setPanelHeight(nextHeight);
  };
  const handleResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.localStorage.setItem("pi-command-console-height", String(panelHeightRef.current));
  };

  return (
    <section
      id="command-console"
      aria-label={t("terminal.title")}
      style={{
        display: open ? "flex" : "none",
        flexDirection: "column",
        flex: `0 0 ${panelHeight}px`,
        minHeight: MIN_HEIGHT,
        position: "relative",
        overflow: "visible",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div
        data-terminal-resize-handle="true"
        role="separator"
        aria-label={t("terminal.resize")}
        aria-orientation="horizontal"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        style={{ position: "absolute", zIndex: 2, top: -12, left: 0, right: 0, height: 24, cursor: "row-resize", touchAction: "none", userSelect: "none", background: "transparent" }}
      />
      <div
        ref={terminalHostRef}
        onClick={() => terminalRef.current?.focus()}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "6px 8px", background: "var(--bg)", fontFamily: TERMINAL_FONT_FAMILY, fontSize: 12 }}
      />
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CommandConsoleEvent, CommandConsoleWireEvent } from "@/lib/command-console";
import { stripAnsi } from "@/lib/ansi";
import { useI18n } from "@/hooks/useI18n";

const MAX_TRANSCRIPT_LENGTH = 1_000_000;
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 140;

type ConsoleViewState = {
  transcript: string;
  cwd: string;
  busy: boolean;
  alive: boolean;
};

function appendTranscript(current: string, text: string): string {
  const next = current + text;
  if (next.length <= MAX_TRANSCRIPT_LENGTH) return next;
  return `[earlier output truncated]\n${next.slice(next.length - MAX_TRANSCRIPT_LENGTH)}`;
}

function ensureLineBreak(value: string): string {
  return !value || value.endsWith("\n") ? value : `${value}\n`;
}

export function applyCommandConsoleEvent(
  state: ConsoleViewState,
  event: CommandConsoleEvent,
): ConsoleViewState {
  switch (event.type) {
    case "ready":
      return { ...state, cwd: event.cwd, alive: true };
    case "output":
      return { ...state, transcript: appendTranscript(state.transcript, event.data) };
    case "command_start": {
      const beforePrompt = ensureLineBreak(state.transcript);
      return {
        ...state,
        cwd: event.cwd,
        busy: true,
        transcript: appendTranscript(beforePrompt, `${event.cwd} $ ${event.command}\n`),
      };
    }
    case "command_end": {
      let transcript = ensureLineBreak(state.transcript);
      if (event.status !== 0) transcript = appendTranscript(transcript, `[exit ${event.status}]\n`);
      return { ...state, transcript, cwd: event.cwd, busy: false };
    }
    case "clear":
      return { ...state, transcript: "" };
    case "error":
      return {
        ...state,
        transcript: appendTranscript(ensureLineBreak(state.transcript), `[error] ${event.message}\n`),
      };
    case "exit": {
      const reason = event.signal ? `signal ${event.signal}` : `exit ${event.code ?? "unknown"}`;
      return {
        ...state,
        alive: false,
        busy: false,
        transcript: appendTranscript(ensureLineBreak(state.transcript), `[console closed: ${reason}]\n`),
      };
    }
  }
}

interface Props {
  cwd: string | null;
  open: boolean;
  onClose: () => void;
}

export function CommandConsole({ cwd, open, onClose }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<ConsoleViewState>({
    transcript: "",
    cwd: cwd ?? "",
    busy: false,
    alive: false,
  });
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [panelHeight, setPanelHeight] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_HEIGHT;
    const stored = Number(window.localStorage.getItem("pi-command-console-height"));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
  });
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionRootRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const creatingRef = useRef(false);
  const panelHeightRef = useRef(panelHeight);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const closeTransport = useCallback((deleteRemote: boolean) => {
    generationRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    sessionRootRef.current = null;
    creatingRef.current = false;
    setConnectionState("idle");
    if (deleteRemote && id) {
      void fetch(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
  }, []);

  const handleWireEvent = useCallback((event: CommandConsoleWireEvent) => {
    if (event.type === "snapshot") {
      let next: ConsoleViewState = {
        transcript: "",
        cwd: event.cwd,
        busy: false,
        alive: event.alive,
      };
      for (const historicalEvent of event.events) {
        next = applyCommandConsoleEvent(next, historicalEvent);
      }
      next.busy = event.busy;
      next.alive = event.alive;
      setView(next);
      return;
    }
    setView((current) => applyCommandConsoleEvent(current, event));
  }, []);

  const startConsole = useCallback(async (root: string) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    const generation = ++generationRef.current;
    setConnectionState("connecting");
    setView({ transcript: "", cwd: root, busy: false, alive: false });
    try {
      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root }),
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
      setView((current) => ({ ...current, cwd: data.cwd!, alive: true }));
      const source = new EventSource(`/api/terminal/${encodeURIComponent(data.id)}/events`);
      eventSourceRef.current = source;
      source.onopen = () => setConnectionState("connected");
      source.onmessage = (message) => {
        try {
          handleWireEvent(JSON.parse(message.data) as CommandConsoleWireEvent);
        } catch {
          // Ignore malformed transport events and keep the console connected.
        }
      };
      source.onerror = () => setConnectionState("error");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setConnectionState("error");
      setView((current) => applyCommandConsoleEvent(current, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (generation === generationRef.current) creatingRef.current = false;
    }
  }, [handleWireEvent]);

  useEffect(() => {
    if (sessionIdRef.current && sessionRootRef.current !== cwd) {
      closeTransport(true);
      setView({ transcript: "", cwd: cwd ?? "", busy: false, alive: false });
    }
    if (open && cwd && !sessionIdRef.current && !creatingRef.current) {
      void startConsole(cwd);
    }
  }, [closeTransport, cwd, open, startConsole]);

  useEffect(() => () => closeTransport(true), [closeTransport]);

  useEffect(() => {
    if (!open) return;
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [open, view.transcript]);

  useEffect(() => {
    if (open && !view.busy) inputRef.current?.focus();
  }, [open, view.busy]);

  const sendAction = useCallback(async (action: "command" | "interrupt" | "clear", command?: string) => {
    const id = sessionIdRef.current;
    if (!id) throw new Error("Command console is not connected");
    const response = await fetch(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(command === undefined ? {} : { command }) }),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  }, []);

  const submit = useCallback(async () => {
    const command = input.trimEnd();
    if (!command.trim() || view.busy || !view.alive) return;
    setInput("");
    setHistory((current) => current[current.length - 1] === command ? current : [...current, command]);
    setHistoryIndex(-1);
    setView((current) => ({ ...current, busy: true }));
    try {
      await sendAction("command", command);
    } catch (error) {
      setView((current) => applyCommandConsoleEvent({ ...current, busy: false }, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [input, sendAction, view.alive, view.busy]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "c" && event.ctrlKey && view.busy) {
      event.preventDefault();
      void sendAction("interrupt").catch(() => {});
      return;
    }
    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      void sendAction("clear").catch(() => setView((current) => ({ ...current, transcript: "" })));
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey && input.indexOf("\n") < 0 && history.length > 0) {
      event.preventDefault();
      const nextIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex]);
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && historyIndex >= 0) {
      event.preventDefault();
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex]);
      }
    }
  };

  const restart = () => {
    if (!cwd) return;
    closeTransport(true);
    setView({ transcript: "", cwd, busy: false, alive: false });
    void startConsole(cwd);
  };

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
        overflow: "hidden",
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div
        role="separator"
        aria-label={t("terminal.resize")}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        style={{ height: 5, flexShrink: 0, cursor: "row-resize", touchAction: "none", background: "transparent" }}
      />
      <header style={{ height: 31, display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "0 8px 0 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>{t("terminal.title")}</span>
        <span title={view.cwd} style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
          {view.cwd}
        </span>
        <span title={connectionState} style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: connectionState === "connected" && view.alive ? "#22c55e" : connectionState === "connecting" ? "#eab308" : "#ef4444" }} />
        {view.busy && (
          <button type="button" onClick={() => void sendAction("interrupt").catch(() => {})} title={t("terminal.interrupt")} style={{ height: 23, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "none", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
            {t("terminal.stop")}
          </button>
        )}
        <button type="button" onClick={() => void sendAction("clear").catch(() => setView((current) => ({ ...current, transcript: "" })))} title={t("terminal.clear")} style={{ width: 24, height: 24, border: 0, borderRadius: 4, background: "none", color: "var(--text-muted)", cursor: "pointer" }}>⌫</button>
        <button type="button" onClick={restart} title={t("terminal.restart")} style={{ width: 24, height: 24, border: 0, borderRadius: 4, background: "none", color: "var(--text-muted)", cursor: "pointer" }}>↻</button>
        <button type="button" onClick={onClose} title={t("terminal.hide")} aria-label={t("terminal.hide")} style={{ width: 24, height: 24, border: 0, borderRadius: 4, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
      </header>
      <pre
        ref={outputRef}
        tabIndex={0}
        style={{ flex: 1, minHeight: 0, margin: 0, padding: "8px 10px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.45 }}
      >
        {stripAnsi(view.transcript)}
      </pre>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 7, flexShrink: 0, padding: "7px 9px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <span aria-hidden="true" style={{ padding: "5px 0", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12 }}>$</span>
        <textarea
          ref={inputRef}
          value={input}
          disabled={!view.alive || connectionState === "connecting"}
          rows={1}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={view.busy ? t("terminal.running") : t("terminal.placeholder")}
          aria-label={t("terminal.commandInput")}
          style={{ minWidth: 0, flex: 1, maxHeight: 86, resize: "vertical", padding: "5px 7px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.4 }}
        />
        <button type="button" onClick={() => void submit()} disabled={!input.trim() || view.busy || !view.alive} style={{ height: 29, padding: "0 11px", border: 0, borderRadius: 5, background: input.trim() && !view.busy && view.alive ? "var(--accent)" : "var(--bg-selected)", color: input.trim() && !view.busy && view.alive ? "#fff" : "var(--text-dim)", cursor: input.trim() && !view.busy && view.alive ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600 }}>
          {t("terminal.run")}
        </button>
      </div>
    </section>
  );
}

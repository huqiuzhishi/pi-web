"use client";

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";

interface Props {
  initialValue: string;
  language: string;
  isDark: boolean;
  wrapLines: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

function languageExtension(language: string): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "python":
      return python();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "css":
      return css();
    default:
      return [];
  }
}

const editorChrome = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "0",
  },
  ".cm-line": {
    padding: "0 8px",
  },
  ".cm-gutters": {
    minWidth: "48px",
    borderRight: "1px solid var(--border)",
    borderLeft: "none",
    backgroundColor: "var(--bg-panel)",
    color: "var(--text-dim)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "47px",
    padding: "0 10px 0 4px",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-focused": {
    outline: "none",
  },
});

export function CodeEditor({
  initialValue,
  language,
  isDark,
  wrapLines,
  disabled = false,
  onChange,
  onSave,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const languageCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const wrappingCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        basicSetup,
        editorChrome,
        languageCompartmentRef.current.of(languageExtension(language)),
        themeCompartmentRef.current.of(isDark ? oneDark : []),
        wrappingCompartmentRef.current.of(wrapLines ? EditorView.lineWrapping : []),
        editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
        keymap.of([{
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: root });
    viewRef.current = view;
    view.focus();

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // initialValue is intentionally mount-only. The editor owns its document
    // while mounted; the parent persists each change for tab restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartmentRef.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartmentRef.current.reconfigure(isDark ? oneDark : []),
    });
  }, [isDark]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrappingCompartmentRef.current.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    });
  }, [wrapLines]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  return <div ref={rootRef} style={{ height: "100%", minHeight: 0 }} />;
}

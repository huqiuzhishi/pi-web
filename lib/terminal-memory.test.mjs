import assert from "node:assert/strict";
import test from "node:test";

import {
  forgetRememberedTerminal,
  getRememberedTerminalId,
  rememberTerminalId,
} from "./terminal-memory.ts";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("terminals are remembered independently per workspace", () => {
  const storage = createStorage();
  rememberTerminalId("/repo/one", "terminal-1", storage);
  rememberTerminalId("/repo/two", "terminal-2", storage);

  assert.equal(getRememberedTerminalId("/repo/one", storage), "terminal-1");
  assert.equal(getRememberedTerminalId("/repo/two", storage), "terminal-2");
});

test("forget only removes the terminal id that is still current", () => {
  const storage = createStorage();
  rememberTerminalId("/repo", "new-terminal", storage);

  forgetRememberedTerminal("/repo", "stale-terminal", storage);
  assert.equal(getRememberedTerminalId("/repo", storage), "new-terminal");

  forgetRememberedTerminal("/repo", "new-terminal", storage);
  assert.equal(getRememberedTerminalId("/repo", storage), null);
});

test("malformed terminal memory is ignored", () => {
  const storage = createStorage();
  storage.setItem("pi-web:terminal-by-workspace", "not-json");
  assert.equal(getRememberedTerminalId("/repo", storage), null);
});

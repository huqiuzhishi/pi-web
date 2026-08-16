import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consoleSource = await readFile(new URL("./CommandConsole.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mounts a workspace-scoped terminal as a bottom panel", () => {
  assert.match(shellSource, /import \{ CommandConsole \} from "\.\/CommandConsole"/);
  assert.match(shellSource, /<CommandConsole[\s\S]*cwd=\{projectTrustCwd \?\? activeCwd\}[\s\S]*open=\{terminalOpen\}/);
  assert.match(shellSource, /aria-controls="command-console"/);
});

test("terminal uses xterm with raw input, PTY resizing, and reconnect replay", () => {
  assert.match(consoleSource, /import\("@xterm\/xterm"\)/);
  assert.match(consoleSource, /import\("@xterm\/addon-fit"\)/);
  assert.match(globalStyles, /@xterm\/xterm\/css\/xterm\.css/);
  assert.match(consoleSource, /terminal\.onData\(queueInput\)/);
  assert.match(consoleSource, /terminal\.onBinary\(queueInput\)/);
  assert.match(consoleSource, /action: "input", \.\.\.input/);
  assert.match(consoleSource, /splitTerminalInput\(data\)/);
  assert.match(consoleSource, /action: "resize", cols, rows/);
  assert.match(consoleSource, /event\.type === "snapshot"/);
  assert.match(consoleSource, /fitAddonRef\.current\.fit\(\)/);
});

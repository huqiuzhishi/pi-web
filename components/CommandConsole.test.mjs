import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consoleSource = await readFile(new URL("./CommandConsole.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const terminalRouteSource = await readFile(new URL("../app/api/terminal/[id]/route.ts", import.meta.url), "utf8");
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
  assert.match(consoleSource, /getComputedStyle\(terminalHostRef\.current\)/);
  assert.match(consoleSource, /fontFamily: terminalStyles\.fontFamily/);
  assert.match(consoleSource, /fontSize: Number\.parseFloat\(terminalStyles\.fontSize\)/);
  assert.match(consoleSource, /JetBrainsMono Nerd Font Mono/);
  assert.match(consoleSource, /fontFamily: TERMINAL_FONT_FAMILY[\s\S]*fontSize: 12/);
});

test("terminal reconnects to the workspace PTY across refreshes", () => {
  assert.match(consoleSource, /getRememberedTerminalId\(root\)/);
  assert.match(consoleSource, /fetch\(`\/api\/terminal\/\$\{encodeURIComponent\(rememberedId\)\}`/);
  assert.match(consoleSource, /rememberTerminalId\(root, id\)/);
  assert.match(consoleSource, /useEffect\(\(\) => \(\) => closeTransport\(false\)/);
  assert.doesNotMatch(consoleSource, /closeTransport\(true\)/);
  assert.match(terminalRouteSource, /export async function GET/);
  assert.match(terminalRouteSource, /cwd: session\.initialCwd/);
});

test("terminal panel visibility and file views are restored from browser storage", () => {
  assert.match(shellSource, /loadFilePanelStates\(\)/);
  assert.match(shellSource, /persistFilePanelStates\(filePanelStates/);
  assert.match(shellSource, /TERMINAL_OPEN_STORAGE_KEY/);
});

test("terminal uses a single-line divider with an overlaid touch resize target", () => {
  assert.match(consoleSource, /borderTop: "1px solid var\(--border\)"/);
  assert.match(consoleSource, /role="separator"[\s\S]*position: "absolute"[\s\S]*height: 24/);
  assert.match(consoleSource, /touchAction: "none"/);
  assert.match(consoleSource, /data-terminal-resize-handle="true"/);
  assert.doesNotMatch(consoleSource, /<header/);
});

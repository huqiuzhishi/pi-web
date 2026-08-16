import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const consoleSource = await readFile(new URL("./CommandConsole.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("mounts a workspace-scoped command console as a bottom panel", () => {
  assert.match(shellSource, /import \{ CommandConsole \} from "\.\/CommandConsole"/);
  assert.match(shellSource, /<CommandConsole[\s\S]*cwd=\{projectTrustCwd \?\? activeCwd\}[\s\S]*open=\{terminalOpen\}/);
  assert.match(shellSource, /aria-controls="command-console"/);
});

test("command console exposes persistent command controls", () => {
  assert.match(consoleSource, /new EventSource\(`\/api\/terminal\/\$\{encodeURIComponent\(data\.id\)\}\/events`\)/);
  assert.match(consoleSource, /action: "command" \| "interrupt" \| "clear"/);
  assert.match(consoleSource, /event\.key === "c" && event\.ctrlKey && view\.busy/);
  assert.match(consoleSource, /event\.key === "ArrowUp"/);
});

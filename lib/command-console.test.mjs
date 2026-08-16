import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

async function loadSubject() {
  return jiti.import("./command-console.ts");
}

function collectEvents(session) {
  const events = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "snapshot") events.push(...event.events);
    else events.push(event);
  });
  return { events, unsubscribe };
}

function outputOf(events) {
  return events
    .filter((event) => event.type === "output")
    .map((event) => event.data)
    .join("");
}

function waitForOutput(session, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for terminal output matching ${pattern}; received ${JSON.stringify(output)}`));
    }, 5_000);
    unsubscribe = session.subscribe((event) => {
      const incoming = event.type === "output"
        ? event.data
        : event.type === "snapshot"
          ? outputOf(event.events)
          : "";
      output += incoming;
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(output);
    });
  });
}

test("PTY terminal streams output and preserves shell cwd and environment", async (t) => {
  if (process.platform === "win32") return t.skip("Unix shell assertions do not apply to ConPTY");
  const { createCommandConsoleSession, deleteCommandConsoleSession } = await loadSubject();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-terminal-test-"));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const session = await createCommandConsoleSession(root, { cols: 90, rows: 20 });
  t.after(() => {
    deleteCommandConsoleSession(session.id);
    return rm(root, { recursive: true, force: true });
  });
  const { events, unsubscribe } = collectEvents(session);
  t.after(unsubscribe);

  assert.deepEqual(session.dimensions, { cols: 90, rows: 20 });
  session.writeInput(1, "stty -echo\r");
  await delay(100);
  session.writeInput(2, "printf '\\n__HELLO_PTY__\\n'\r");
  await waitForOutput(session, /\r\n__HELLO_PTY__\r\n/);

  session.writeInput(3, "cd nested; export PI_WEB_TEST_VALUE=kept; printf '\\n__STATE_SET__\\n'\r");
  await waitForOutput(session, /\r\n__STATE_SET__\r\n/);
  session.writeInput(4, "printf '\\n__STATE__%s:%s\\n' \"$PWD\" \"$PI_WEB_TEST_VALUE\"\r");
  await waitForOutput(session, /\r\n__STATE__.*:kept\r\n/);

  const output = outputOf(events);
  assert.match(output, /__HELLO_PTY__/);
  assert.match(output, new RegExp(`${nested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:kept`));
});

test("PTY terminal orders retry-safe input, interrupts, resizes, and clears replay history", async (t) => {
  if (process.platform === "win32") return t.skip("Unix shell assertions do not apply to ConPTY");
  const { createCommandConsoleSession, deleteCommandConsoleSession } = await loadSubject();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-terminal-test-"));
  const session = await createCommandConsoleSession(root);
  t.after(() => {
    deleteCommandConsoleSession(session.id);
    return rm(root, { recursive: true, force: true });
  });

  session.writeInput(2, "printf '\\n__SECOND__\\n'\r");
  session.writeInput(1, "stty -echo; printf '\\n__FIRST__\\n'\r");
  const orderedOutput = await waitForOutput(session, /\r\n__SECOND__\r\n/);
  assert.ok(orderedOutput.indexOf("__FIRST__") < orderedOutput.indexOf("__SECOND__"));
  session.writeInput(2, "ignored duplicate");

  session.writeInput(3, "sleep 10\r");
  await delay(100);
  session.writeInput(4, "\x03");
  session.writeInput(5, "printf '\\n__INTERRUPTED__\\n'\r");
  await waitForOutput(session, /\r\n__INTERRUPTED__\r\n/);

  session.resize(120, 35);
  assert.deepEqual(session.dimensions, { cols: 120, rows: 35 });
  session.clearHistory();
  let snapshot;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "snapshot") snapshot = event;
  });
  unsubscribe();
  assert.deepEqual(snapshot.events, [{ type: "clear" }]);
  assert.equal(snapshot.nextInputSequence, 6);
});

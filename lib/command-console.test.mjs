import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
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

function waitForCommandEnd(session, sequence) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for command completion"));
    }, 5_000);
    unsubscribe = session.subscribe((event) => {
      const match = event.type === "command_end" && event.sequence === sequence
        ? event
        : event.type === "snapshot"
          ? event.events.find((item) => item.type === "command_end" && item.sequence === sequence)
          : undefined;
      if (!match) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(match);
    });
  });
}

test("persistent command console streams output and keeps cwd and environment changes", async (t) => {
  if (process.platform === "win32") return t.skip("Bash process groups are platform-specific");
  const { createCommandConsoleSession, deleteCommandConsoleSession } = await loadSubject();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-console-test-"));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const session = await createCommandConsoleSession(root);
  t.after(() => {
    deleteCommandConsoleSession(session.id);
    return rm(root, { recursive: true, force: true });
  });
  const { events, unsubscribe } = collectEvents(session);
  t.after(unsubscribe);

  let sequence = await session.runCommand("printf 'hello-console'");
  let completed = await waitForCommandEnd(session, sequence);
  assert.equal(completed.status, 0);
  assert.match(events.filter((event) => event.type === "output").map((event) => event.data).join(""), /hello-console/);

  sequence = await session.runCommand("cd nested\nexport PI_WEB_TEST_VALUE=kept");
  completed = await waitForCommandEnd(session, sequence);
  const canonicalNested = await realpath(nested);
  assert.equal(completed.cwd, canonicalNested);
  assert.equal(session.cwd, canonicalNested);

  sequence = await session.runCommand("printf '%s:%s' \"$PWD\" \"$PI_WEB_TEST_VALUE\"");
  await waitForCommandEnd(session, sequence);
  const output = events.filter((event) => event.type === "output").map((event) => event.data).join("");
  assert.match(output, new RegExp(`${canonicalNested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:kept`));
});

test("command console rejects overlap, supports interruption, and clears replay history", async (t) => {
  if (process.platform === "win32") return t.skip("Bash process groups are platform-specific");
  const { createCommandConsoleSession, deleteCommandConsoleSession } = await loadSubject();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-console-test-"));
  const session = await createCommandConsoleSession(root);
  t.after(() => {
    deleteCommandConsoleSession(session.id);
    return rm(root, { recursive: true, force: true });
  });

  const sequence = await session.runCommand("sleep 10");
  await assert.rejects(() => session.runCommand("printf overlap"), /already running/);
  await delay(100);
  session.interrupt();
  const completed = await waitForCommandEnd(session, sequence);
  assert.notEqual(completed.status, 0);

  session.clearHistory();
  await delay(5);
  let snapshot;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "snapshot") snapshot = event;
  });
  unsubscribe();
  assert.deepEqual(snapshot.events, [{ type: "clear" }]);
});

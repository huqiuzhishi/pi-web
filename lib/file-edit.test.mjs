import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  FileEditError,
  readTextFileSnapshotSync,
  writeTextFileIfVersionMatchesSync,
} = await import("./file-edit.ts");

function fixture(t, content = "first\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-edit-"));
  const filePath = path.join(root, "example.ts");
  fs.writeFileSync(filePath, content, { mode: 0o754 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return filePath;
}

test("reads a versioned UTF-8 text snapshot", (t) => {
  const filePath = fixture(t);
  const snapshot = readTextFileSnapshotSync(filePath);

  assert.equal(snapshot.content, "first\n");
  assert.equal(snapshot.version.size, 6);
  assert.match(snapshot.version.sha256, /^[a-f0-9]{64}$/);
});

test("atomically saves matching text while preserving permissions", (t) => {
  const filePath = fixture(t);
  const original = readTextFileSnapshotSync(filePath);
  const saved = writeTextFileIfVersionMatchesSync(filePath, "second\n", original.version);

  assert.equal(saved.content, "second\n");
  assert.notEqual(saved.version.sha256, original.version.sha256);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o754);
  assert.equal(fs.readFileSync(filePath, "utf8"), "second\n");
});

test("rejects a stale save without changing the external edit", (t) => {
  const filePath = fixture(t);
  const original = readTextFileSnapshotSync(filePath);
  fs.writeFileSync(filePath, "external\n");

  assert.throws(
    () => writeTextFileIfVersionMatchesSync(filePath, "local\n", original.version),
    (error) => error instanceof FileEditError
      && error.code === "conflict"
      && error.currentVersion?.sha256 !== original.version.sha256,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "external\n");
});

test("rejects symbolic links and binary files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-edit-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  const binary = path.join(root, "binary.dat");
  fs.writeFileSync(target, "target");
  fs.symlinkSync(target, link);
  fs.writeFileSync(binary, Buffer.from([1, 0, 2]));

  assert.throws(
    () => readTextFileSnapshotSync(link),
    (error) => error instanceof FileEditError && error.code === "symlink",
  );
  assert.equal(
    readTextFileSnapshotSync(link, { allowSymbolicLink: true }).content,
    "target",
  );
  assert.throws(
    () => readTextFileSnapshotSync(binary),
    (error) => error instanceof FileEditError && error.code === "binary",
  );
});

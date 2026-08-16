import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { GitFileRevertError, revertGitFile } = await jiti.import("./git-changes.ts");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-revert-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "example.txt"), "original\n");
  git(root, "add", "example.txt");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

test("reverts staged and unstaged changes to a tracked file", async (t) => {
  const root = repository(t);
  const filePath = path.join(root, "example.txt");
  fs.writeFileSync(filePath, "staged\n");
  git(root, "add", "example.txt");
  fs.writeFileSync(filePath, "worktree\n");

  const result = await revertGitFile(root, filePath);

  assert.deepEqual(result, { reverted: true, filePath });
  assert.equal(fs.readFileSync(filePath, "utf8"), "original\n");
  assert.equal(git(root, "status", "--short"), "");
});

test("restores deleted and renamed files to their HEAD paths", async (t) => {
  const root = repository(t);
  const originalPath = path.join(root, "example.txt");

  fs.rmSync(originalPath);
  git(root, "add", "--update");
  assert.deepEqual(await revertGitFile(root, originalPath), {
    reverted: true,
    filePath: originalPath,
  });
  assert.equal(fs.readFileSync(originalPath, "utf8"), "original\n");

  const renamedPath = path.join(root, "renamed.txt");
  git(root, "mv", "example.txt", "renamed.txt");
  assert.deepEqual(await revertGitFile(root, renamedPath), {
    reverted: true,
    filePath: originalPath,
  });
  assert.equal(fs.existsSync(renamedPath), false);
  assert.equal(fs.readFileSync(originalPath, "utf8"), "original\n");
  assert.equal(git(root, "status", "--short"), "");
});

test("removes staged additions but refuses to delete untracked files", async (t) => {
  const root = repository(t);
  const addedPath = path.join(root, "added.txt");
  fs.writeFileSync(addedPath, "added\n");
  git(root, "add", "added.txt");

  assert.deepEqual(await revertGitFile(root, addedPath), {
    reverted: true,
    filePath: null,
  });
  assert.equal(fs.existsSync(addedPath), false);

  const untrackedPath = path.join(root, "untracked.txt");
  fs.writeFileSync(untrackedPath, "keep me\n");
  await assert.rejects(
    () => revertGitFile(root, untrackedPath),
    (error) => error instanceof GitFileRevertError && error.code === "untracked",
  );
  assert.equal(fs.readFileSync(untrackedPath, "utf8"), "keep me\n");
});

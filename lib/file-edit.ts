import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";

const TEXT_EDIT_MAX_BYTES = 256 * 1024;

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256: string;
}

export interface TextFileSnapshot {
  content: string;
  version: FileVersion;
}

export type FileEditErrorCode =
  | "not_found"
  | "not_file"
  | "symlink"
  | "too_large"
  | "binary"
  | "conflict";

export class FileEditError extends Error {
  readonly code: FileEditErrorCode;
  readonly currentVersion?: FileVersion;

  constructor(code: FileEditErrorCode, message: string, currentVersion?: FileVersion) {
    super(message);
    this.name = "FileEditError";
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

function hashBuffer(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function versionOf(stat: fs.Stats, contents: Buffer): FileVersion {
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: hashBuffer(contents),
  };
}

function readSnapshotWithMode(
  filePath: string,
  allowSymbolicLink = false,
): TextFileSnapshot & { mode: number } {
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileEditError("not_found", "File not found");
    }
    throw error;
  }
  if (linkStat.isSymbolicLink() && !allowSymbolicLink) {
    throw new FileEditError("symlink", "Symbolic links cannot be edited");
  }
  if (!linkStat.isSymbolicLink() && !linkStat.isFile()) {
    throw new FileEditError("not_file", "Not a file");
  }
  if (!linkStat.isSymbolicLink() && linkStat.size > TEXT_EDIT_MAX_BYTES) {
    throw new FileEditError("too_large", "File is too large to edit (>256KB)");
  }

  const descriptor = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new FileEditError("not_file", "Not a file");
    if (stat.size > TEXT_EDIT_MAX_BYTES) {
      throw new FileEditError("too_large", "File is too large to edit (>256KB)");
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.includes(0)) {
      throw new FileEditError("binary", "Binary files cannot be edited");
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new FileEditError("binary", "File is not valid UTF-8 text");
    }

    return {
      content,
      version: versionOf(stat, contents),
      mode: stat.mode & 0o777,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readTextFileSnapshotSync(
  filePath: string,
  options: { allowSymbolicLink?: boolean } = {},
): TextFileSnapshot {
  const { content, version } = readSnapshotWithMode(filePath, options.allowSymbolicLink);
  return { content, version };
}

export function writeTextFileIfVersionMatchesSync(
  filePath: string,
  content: string,
  expectedVersion: FileVersion,
): TextFileSnapshot {
  const contents = Buffer.from(content, "utf8");
  if (contents.length > TEXT_EDIT_MAX_BYTES) {
    throw new FileEditError("too_large", "File is too large to edit (>256KB)");
  }
  if (contents.includes(0)) {
    throw new FileEditError("binary", "Binary files cannot be edited");
  }

  const current = readSnapshotWithMode(filePath);
  if (current.version.sha256 !== expectedVersion.sha256) {
    throw new FileEditError("conflict", "File changed on disk", current.version);
  }

  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(temporaryPath, contents, {
      flag: "wx",
      mode: current.mode,
      flush: true,
    });

    // Narrow the race with editors that do not participate in a lock: verify
    // the source again immediately before the atomic replacement.
    const latest = readSnapshotWithMode(filePath);
    if (latest.version.sha256 !== expectedVersion.sha256) {
      throw new FileEditError("conflict", "File changed on disk", latest.version);
    }

    fs.renameSync(temporaryPath, filePath);
    renamed = true;
    return readTextFileSnapshotSync(filePath);
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function isFileVersion(value: unknown): value is FileVersion {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileVersion>;
  return Number.isFinite(candidate.mtimeMs)
    && Number.isInteger(candidate.size)
    && (candidate.size ?? -1) >= 0
    && typeof candidate.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(candidate.sha256);
}

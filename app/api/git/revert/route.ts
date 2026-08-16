import { NextRequest, NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "@/lib/file-access";
import { GitFileRevertError, revertGitFile } from "@/lib/git-changes";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { cwd?: unknown; path?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const filePath = typeof body.path === "string" ? body.path.trim() : "";

    if (!cwd || !isAbsolutePath(cwd)) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!filePath || !isAbsolutePath(filePath)) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (
      !isFilePathAllowed(cwd, allowedRoots)
      || !isFilePathAllowed(filePath, allowedRoots)
      || !isExistingFilePathAllowed(cwd, allowedRoots)
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await revertGitFile(cwd, filePath));
  } catch (error) {
    if (error instanceof GitFileRevertError) {
      const status = error.code === "no_changes" ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

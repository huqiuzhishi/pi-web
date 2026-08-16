import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createCommandConsoleSession } from "@/lib/command-console";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { hasJsonContentType } from "@/lib/request-security";

// POST /api/terminal  body: { cwd: string }
export async function POST(request: Request) {
  try {
    if (!hasJsonContentType(request)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    const body = await request.json() as { cwd?: unknown };
    const cwdValue = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwdValue || !path.isAbsolute(cwdValue)) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const cwd = path.resolve(cwdValue);
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const cwdStat = await stat(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      return NextResponse.json({ error: "Working directory not found" }, { status: 404 });
    }

    const session = await createCommandConsoleSession(cwd);
    return NextResponse.json({ id: session.id, cwd: session.cwd });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

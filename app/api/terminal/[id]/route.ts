import { NextResponse } from "next/server";
import {
  deleteCommandConsoleSession,
  getCommandConsoleSession,
} from "@/lib/command-console";
import { hasJsonContentType } from "@/lib/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// POST /api/terminal/:id  body: { action: "command" | "interrupt" | "clear", command?: string }
export async function POST(request: Request, { params }: RouteContext) {
  try {
    if (!hasJsonContentType(request)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    const { id } = await params;
    const session = getCommandConsoleSession(id);
    if (!session) return NextResponse.json({ error: "Command console not found" }, { status: 404 });

    const body = await request.json() as { action?: unknown; command?: unknown };
    if (body.action === "command") {
      if (typeof body.command !== "string") {
        return NextResponse.json({ error: "command must be a string" }, { status: 400 });
      }
      const sequence = await session.runCommand(body.command);
      return NextResponse.json({ success: true, sequence }, { status: 202 });
    }
    if (body.action === "interrupt") {
      session.interrupt();
      return NextResponse.json({ success: true });
    }
    if (body.action === "clear") {
      session.clearHistory();
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "A command is already running" ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const deleted = deleteCommandConsoleSession(id);
  return deleted
    ? NextResponse.json({ success: true })
    : NextResponse.json({ error: "Command console not found" }, { status: 404 });
}

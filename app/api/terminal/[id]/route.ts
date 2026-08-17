import { NextResponse } from "next/server";
import {
  deleteCommandConsoleSession,
  getCommandConsoleSession,
} from "@/lib/command-console";
import { hasJsonContentType } from "@/lib/request-security";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/terminal/:id - metadata used to reconnect after a page refresh.
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const session = getCommandConsoleSession(id);
  if (!session) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  return NextResponse.json({
    id: session.id,
    cwd: session.initialCwd,
    alive: session.isAlive,
    ...session.dimensions,
  });
}

// POST /api/terminal/:id
// body: { action: "input", sequence, data } | { action: "resize", cols, rows } | { action: "clear" }
export async function POST(request: Request, { params }: RouteContext) {
  try {
    if (!hasJsonContentType(request)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    const { id } = await params;
    const session = getCommandConsoleSession(id);
    if (!session) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });

    const body = await request.json() as Record<string, unknown>;
    if (body.action === "input") {
      if (typeof body.sequence !== "number" || typeof body.data !== "string") {
        return NextResponse.json({ error: "sequence must be a number and data must be a string" }, { status: 400 });
      }
      session.writeInput(body.sequence, body.data);
      return NextResponse.json({ success: true, nextInputSequence: body.sequence + 1 }, { status: 202 });
    }
    if (body.action === "resize") {
      if (typeof body.cols !== "number" || typeof body.rows !== "number") {
        return NextResponse.json({ error: "cols and rows must be numbers" }, { status: 400 });
      }
      session.resize(body.cols, body.rows);
      return NextResponse.json({ success: true, ...session.dimensions });
    }
    if (body.action === "clear") {
      session.clearHistory();
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /Invalid|too large|too far|too much/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const deleted = deleteCommandConsoleSession(id);
  return deleted
    ? NextResponse.json({ success: true })
    : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
}

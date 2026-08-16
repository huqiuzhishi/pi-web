import { getCommandConsoleSession } from "@/lib/command-console";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/terminal/:id/events - command output and lifecycle events over SSE.
export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const session = getCommandConsoleSession(id);
  if (!session) return Response.json({ error: "Command console not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleanedUp = false;
      let unsubscribe = () => {};
      const keepAlive = setInterval(() => {
        if (cleanedUp) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The browser already closed the stream.
        }
      };
      const send = (event: unknown) => {
        if (cleanedUp) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      unsubscribe = session.subscribe(send);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

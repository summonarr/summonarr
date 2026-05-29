import { auth, isTokenExpired } from "@/lib/auth";
import { sseEmitter, SSE_MAX_LISTENERS, type SSEEvent } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

const MAX_CONNECTIONS_PER_USER = 5;
// Kept in lockstep with the emitter's max-listener cap (one listener per
// connection); tune both via SSE_MAX_LISTENERS. See @/lib/sse-emitter.
const MAX_TOTAL_CONNECTIONS = SSE_MAX_LISTENERS;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONNECTION_DURATION_MS = 3_600_000;

const connectionCounts = new Map<string, number>();
let totalConnections = 0;

function incrementConnection(userId: string): boolean {
  // Reject before incrementing; only update state when the connection is actually accepted
  const next = (connectionCounts.get(userId) ?? 0) + 1;
  if (next > MAX_CONNECTIONS_PER_USER) return false;
  if (totalConnections >= MAX_TOTAL_CONNECTIONS) return false;
  connectionCounts.set(userId, next);
  totalConnections++;
  return true;
}

function decrementConnection(userId: string) {
  const current = connectionCounts.get(userId) ?? 0;
  if (current <= 1) {
    connectionCounts.delete(userId);
  } else {
    connectionCounts.set(userId, current - 1);
  }
  totalConnections = Math.max(0, totalConnections - 1);
}

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session)) return new Response("Unauthorized", { status: 401 });

  const maint = await maintenanceGuard();
  if (maint) return maint;

  const userId = session.user.id;
  const isSystemAdmin = session.user.role === "ADMIN";
  const isIssueAdmin = session.user.role === "ISSUE_ADMIN";

  if (!incrementConnection(userId)) {
    return new Response("Too many SSE connections", { status: 429 });
  }

  // Per-event-type delivery rules:
  //   activity:* — system admin only (live session/history streams)
  //   issue:* / issuemessage:* — system admin OR ISSUE_ADMIN bypasses per-user filter
  //   everything else (request:*, votes:*, push:*, settings:*) — only system admin bypasses;
  //     ISSUE_ADMIN goes through the same per-user filter as a normal USER.
  // Without this split, ISSUE_ADMIN could observe every user's request/settings/push events.
  function shouldDeliver(eventType: string, evtUserId: string | undefined): boolean {
    if (
      eventType === "activity:sessions"
      || eventType === "activity:history-updated"
      || eventType === "plex:reachability"
    ) {
      return isSystemAdmin;
    }
    const bypassesUserFilter =
      eventType.startsWith("issue:") || eventType.startsWith("issuemessage:")
        ? isSystemAdmin || isIssueAdmin
        : isSystemAdmin;
    if (bypassesUserFilter) return true;
    return evtUserId === userId;
  }

  const encoder = new TextEncoder();
  let listener: ((event: SSEEvent) => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  function cleanup(controller?: ReadableStreamDefaultController) {
    if (cleaned) return;
    cleaned = true;
    if (listener) sseEmitter.off("event", listener);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    decrementConnection(userId);
    try { controller?.close(); } catch { }
  }

  const stream = new ReadableStream({
    start(controller) {

      listener = (event: SSEEvent) => {
        const evtUserId = (event as { userId?: string }).userId;
        if (!shouldDeliver(event.type, evtUserId)) return;
        try {
          // Back-pressure check: stop pushing if the consumer is not reading fast enough
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            cleanup(controller);
            return;
          }

          const { userId: _uid, ...clientEvent } = event as SSEEvent & { userId?: string };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(clientEvent)}\n\n`));
        } catch {
          cleanup(controller);
        }
      };
      sseEmitter.on("event", listener);

      try {
        controller.enqueue(encoder.encode("data: {\"type\":\"connected\"}\n\n"));
      } catch {
        cleanup(controller);
        return;
      }

      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          cleanup(controller);
        }
      }, HEARTBEAT_INTERVAL_MS);

      maxDurationTimer = setTimeout(() => {
        cleanup(controller);
      }, MAX_CONNECTION_DURATION_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // prevents nginx from buffering SSE frames
    },
  });
}

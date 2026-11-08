import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { sseEmitter, SSE_MAX_LISTENERS, type SSEEvent } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { sseClientFrame, sseDeliveryScope, shouldDeliverSseEvent, type SseDeliveryScope } from "@/lib/sse-delivery";

export const dynamic = "force-dynamic";

const MAX_CONNECTIONS_PER_USER = 5;
// Kept in lockstep with the emitter's max-listener cap (one listener per
// connection); tune both via SSE_MAX_LISTENERS. See @/lib/sse-emitter.
const MAX_TOTAL_CONNECTIONS = SSE_MAX_LISTENERS;
// 25s, not 60: a reverse proxy's default idle/read timeout is commonly 60s
// (nginx, Nginx Proxy Manager) and a heartbeat on exactly that cadence loses
// the race often enough that admin browsers logged "[live-events] SSE
// connection error" and reconnected every minute. Stay well under the
// shortest common timeout.
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_CONNECTION_DURATION_MS = 3_600_000;
// Re-validate the session against the DB on this cadence so a revoked or role-demoted
// session stops receiving events (and admin-only streams) mid-connection rather than
// riding the original connect-time authorization until the 1h hard cap.
const REAUTH_INTERVAL_MS = 60_000;
// The stream buffers up to this many frames. The default buffer is 1 frame, and
// events are sent to every listener at once, so two events emitted back-to-back
// would fill it and the backpressure check would disconnect perfectly healthy
// clients. SSE frames are tiny, so 64 is plenty, and a client that has truly
// stopped reading still fills the buffer and gets disconnected.
const STREAM_HIGH_WATER_MARK = 64;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // prevents nginx from buffering SSE frames
};

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

const encoder = new TextEncoder();

/** False when the consumer is not reading fast enough (the buffer above is full). */
function hasRoom(controller: ReadableStreamDefaultController): boolean {
  return controller.desiredSize === null || controller.desiredSize > 0;
}

/**
 * One viewer's event stream, from the accepted connection to its cleanup. The
 * connection slot taken by incrementConnection is released exactly once, by
 * whichever ends it first: the client, backpressure, the hard cap, or a re-auth
 * that no longer admits the session.
 */
function openEventStream(userId: string, initialScope: SseDeliveryScope): ReadableStream<Uint8Array> {
  // Replaced on every re-auth tick, so a demotion narrows delivery live.
  let scope = initialScope;
  let listener: ((event: SSEEvent) => void) | null = null;
  const stopTimers: Array<() => void> = [];
  let cleaned = false;

  function cleanup(controller?: ReadableStreamDefaultController) {
    if (cleaned) return;
    cleaned = true;
    if (listener) sseEmitter.off("event", listener);
    for (const stop of stopTimers) stop();
    decrementConnection(userId);
    try { controller?.close(); } catch { }
  }

  function startTimers(controller: ReadableStreamDefaultController) {
    const heartbeat = setInterval(() => {
      try {
        // enqueue on an unread stream does not throw — it drives desiredSize
        // negative — so a silently-dead client (lid closed, network dropped
        // before TCP notices) would hold a capped connection slot until the
        // 1h max-duration timer. Mirror the event listener's backpressure
        // check and reclaim the slot instead.
        if (!hasRoom(controller)) {
          cleanup(controller);
          return;
        }
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      } catch {
        cleanup(controller);
      }
    }, HEARTBEAT_INTERVAL_MS);
    stopTimers.push(() => clearInterval(heartbeat));

    const maxDuration = setTimeout(() => cleanup(controller), MAX_CONNECTION_DURATION_MS);
    stopTimers.push(() => clearTimeout(maxDuration));

    const reauth = setInterval(() => {
      // Re-run the DB-checked auth against the original request's cookie/bearer.
      // A revoked/expired session yields a NextResponse → tear down; a still-valid
      // session refreshes the delivery scope so a demotion takes effect.
      void requireAuth()
        .then((fresh) => {
          if (cleaned) return;
          if (fresh instanceof NextResponse || fresh.user.id !== userId) {
            cleanup(controller);
            return;
          }
          scope = sseDeliveryScope(fresh.user.permissions);
        })
        .catch(() => cleanup(controller));
    }, REAUTH_INTERVAL_MS);
    stopTimers.push(() => clearInterval(reauth));
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      listener = (event: SSEEvent) => {
        const evtUserId = (event as { userId?: string }).userId;
        if (!shouldDeliverSseEvent(scope, userId, event.type, evtUserId)) return;
        try {
          // Back-pressure check: stop pushing if the consumer is not reading fast enough
          if (!hasRoom(controller)) {
            cleanup(controller);
            return;
          }
          const frame = sseClientFrame(event as SSEEvent & { userId?: string }, userId);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
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
      startTimers(controller);
    },
    cancel() {
      cleanup();
    },
  }, new CountQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER_MARK }));
}

export async function GET() {
  // DB-checked auth (revocation + role refresh + transport binding), not JWT-only
  // auth(). The proxy checks the session on every /api request, but this route
  // does not lean on it alone (guardrail 29's reasoning): the stream outlives the
  // proxy's check by up to an hour, and the re-auth tick below re-runs this same
  // DB-checked read, so a revoked or role-demoted session never keeps riding the
  // connect-time authorization.
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const userId = session.user.id;
  if (!incrementConnection(userId)) {
    return new Response("Too many SSE connections", { status: 429 });
  }
  return new Response(openEventStream(userId, sseDeliveryScope(session.user.permissions)), { headers: SSE_HEADERS });
}

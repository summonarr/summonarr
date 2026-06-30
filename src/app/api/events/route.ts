import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { sseEmitter, SSE_MAX_LISTENERS, type SSEEvent } from "@/lib/sse-emitter";
import { maintenanceGuard } from "@/lib/maintenance";
import { hasPermission, Permission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const MAX_CONNECTIONS_PER_USER = 5;
// Kept in lockstep with the emitter's max-listener cap (one listener per
// connection); tune both via SSE_MAX_LISTENERS. See @/lib/sse-emitter.
const MAX_TOTAL_CONNECTIONS = SSE_MAX_LISTENERS;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_CONNECTION_DURATION_MS = 3_600_000;
// Re-validate the session against the DB on this cadence so a revoked or role-demoted
// session stops receiving events (and admin-only streams) mid-connection rather than
// riding the original connect-time authorization until the 1h hard cap.
const REAUTH_INTERVAL_MS = 60_000;

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
  // DB-checked auth (revocation + role-rotation + UA-fingerprint), not JWT-only
  // auth(). This route is reachable on the prefetch-header path that proxy.ts's
  // matcher skips, so a plain auth() check would honor a revoked or role-demoted
  // session until its natural exp. requireAuth re-runs verifyAndRefreshSession.
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const maint = await maintenanceGuard();
  if (maint) return maint;

  const userId = session.user.id;
  // Mutable so the periodic re-auth below can demote delivery scope live: a session
  // demoted from ADMIN / stripped of MANAGE_ISSUES stops receiving admin/issue events
  // on the next re-auth tick instead of at the next reconnect.
  let isSystemAdmin = hasPermission(session.user.permissions, Permission.ADMIN);
  // Bitmask-authoritative (not role) so a demoted ISSUE_ADMIN with MANAGE_ISSUES
  // cleared stops receiving issue:* / issuemessage:* events. ADMIN still passes via
  // isSystemAdmin above, so this only governs the issue-event bypass.
  let isIssueAdmin = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);

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
  let reauthTimer: ReturnType<typeof setInterval> | null = null;
  let cleaned = false;

  function cleanup(controller?: ReadableStreamDefaultController) {
    if (cleaned) return;
    cleaned = true;
    if (listener) sseEmitter.off("event", listener);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (reauthTimer) clearInterval(reauthTimer);
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

      reauthTimer = setInterval(() => {
        // Re-run the DB-checked auth against the original request's cookie/bearer.
        // A revoked/expired session yields a NextResponse → tear down; a still-valid
        // session refreshes the admin/issue delivery scope so a demotion takes effect.
        void requireAuth()
          .then((fresh) => {
            if (cleaned) return;
            if (fresh instanceof NextResponse || fresh.user.id !== userId) {
              cleanup(controller);
              return;
            }
            isSystemAdmin = hasPermission(fresh.user.permissions, Permission.ADMIN);
            isIssueAdmin = hasPermission(fresh.user.permissions, Permission.MANAGE_ISSUES);
          })
          .catch(() => cleanup(controller));
      }, REAUTH_INTERVAL_MS);
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

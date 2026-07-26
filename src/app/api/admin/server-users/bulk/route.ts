import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { setJellyfinDownloadPolicy } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { settleLimit } from "@/lib/concurrency";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit, auditContext } from "@/lib/audit";

// Cap concurrent Jellyfin policy pushes so a large server-user list doesn't
// saturate the Prisma pool / burst the Jellyfin admin API in one shot.
const POLICY_PUSH_CONCURRENCY = 8;

export const POST = withAdmin(async (req, _ctx, session) => {
  // Bulk policy push fans out to N Jellyfin admin calls per invocation; cap to 5/min per admin
  if (!checkRateLimit(`server-users-bulk:${session.user.id}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many bulk operations — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ source?: string; downloadsEnabled?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { source } = body;

  // Plex is intentionally not supported — its sharing API has no working remote toggle.
  if (source !== "jellyfin") {
    return NextResponse.json({ error: "source must be 'jellyfin'" }, { status: 400 });
  }
  // Validate at runtime (the parsed body's generic type isn't runtime-checked): a
  // non-boolean would reach Prisma's Boolean? column and the Jellyfin policy push
  // as a 500. Mirrors [id]/route.ts.
  if (typeof body.downloadsEnabled !== "boolean") {
    return NextResponse.json({ error: "downloadsEnabled must be a boolean" }, { status: 400 });
  }
  const downloadsEnabled = body.downloadsEnabled;

  const where = { isServerAdmin: false, source: "jellyfin", active: true };

  // Read the target snapshot FIRST and drive the update off those exact ids. Re-running the
  // `where` for the push list would pick up rows the concurrent Jellyfin sync inserted after the
  // updateMany — those users get the policy pushed to Jellyfin while their Summonarr row keeps the
  // old value, and nothing reconciles it (policy is only pushed on an explicit admin action).
  const targets = await prisma.mediaServerUser.findMany({
    where,
    select: { id: true, sourceUserId: true, username: true },
  });

  const updated = await prisma.mediaServerUser.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { downloadsEnabled },
  });

  const { url: jellyfinUrl, apiKey: jellyfinApiKey } = await getJellyfinConfig();

  let pushed = 0;
  let errors = 0;

  if (jellyfinUrl && jellyfinApiKey) {
    await settleLimit(targets, POLICY_PUSH_CONCURRENCY, async (u) => {
      try {
        await setJellyfinDownloadPolicy(jellyfinUrl, jellyfinApiKey, u.sourceUserId, downloadsEnabled);
        pushed++;
      } catch (err) {
        console.warn(`[server-users/bulk] Failed to push policy for jellyfin/${u.username}:`, err instanceof Error ? err.message : String(err));
        errors++;
      }
    });
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SERVER_USERS_BULK",
    target: `server:${source}`,
    details: { downloadsEnabled, targetCount: updated.count, pushed, errors },
    ...auditContext(req, session),
  });

  return NextResponse.json({ ok: true, pushed, errors });
});

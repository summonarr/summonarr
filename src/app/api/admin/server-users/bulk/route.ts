import { NextResponse } from "next/server";
import { mediaInstanceLabel } from "@/lib/media-instances";
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
  // Each call pushes a policy to every Jellyfin user, so cap it at 5 per minute per admin.
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
    select: { id: true, sourceUserId: true, username: true, serverInstance: true },
  });

  const updated = await prisma.mediaServerUser.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { downloadsEnabled },
  });

  // Push PER SERVER. The rows span every configured Jellyfin server, and a
  // sourceUserId only means something on the server that issued it — sending
  // every user to the default server would push unknown (or colliding) ids
  // there while their own server never got the policy.
  const byInstance = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = byInstance.get(t.serverInstance);
    if (list) list.push(t);
    else byInstance.set(t.serverInstance, [t]);
  }

  let pushed = 0;
  let errors = 0;

  for (const [instance, users] of byInstance) {
    const { url: jellyfinUrl, apiKey: jellyfinApiKey } = await getJellyfinConfig(instance);
    if (!jellyfinUrl || !jellyfinApiKey) {
      // Unconfigured (or de-registered) server: the rows still exist but there
      // is nowhere to push. Deliberately NOT counted as an error — "DB updated,
      // nothing pushed" is this route's existing contract for an unconfigured
      // server and its tests pin it. The warning makes it visible that these
      // users' policy never reached a server.
      console.warn(`[server-users/bulk] ${mediaInstanceLabel("jellyfin", instance)} is not configured — ${users.length} user(s) updated in the DB but not pushed.`);
      continue;
    }
    await settleLimit(users, POLICY_PUSH_CONCURRENCY, async (u) => {
      try {
        await setJellyfinDownloadPolicy(jellyfinUrl, jellyfinApiKey, u.sourceUserId, downloadsEnabled);
        pushed++;
      } catch (err) {
        console.warn(`[server-users/bulk] Failed to push policy for ${mediaInstanceLabel("jellyfin", instance)}/${u.username}:`, err instanceof Error ? err.message : String(err));
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

import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { SafeFetchError, safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { jellyfinAdminHeaders } from "@/lib/jellyfin";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { diagnoseJellyfinUser, readUsersBody } from "@/lib/jellyfin-user-diagnosis";

export const GET = withPermission(Permission.MANAGE_USERS)(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  // Which server to diagnose. The live /Users fetch and the DB count below must
  // describe the SAME server, or `gap` compares one server's users against
  // every server's rows. Defaults to "" (the default server), so a
  // single-server deployment needs no parameter.
  const instance = new URL(req.url).searchParams.get("instance") ?? DEFAULT_MEDIA_INSTANCE;
  if (instance !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const { url, apiKey } = await getJellyfinConfig(instance);

  if (!url || !apiKey) {
    return NextResponse.json({ error: t("apiAdmin.common.jellyfinNotConfiguredShort") }, { status: 400 });
  }

  const base = url.replace(/\/$/, "");

  const { httpStatus, rawBody, fetchError } = await fetchUsers(base, apiKey);
  const { items, responseShape } = readUsersBody(rawBody);

  // Flag every user the sync would skip, and say why, so the admin can see it.
  const breakdown = items.map(diagnoseJellyfinUser);
  const skipped = breakdown.filter((u) => u.wouldBeSkipped);
  const processed = breakdown.filter((u) => !u.wouldBeSkipped);

  const dbCount = await prisma.mediaServerUser.count({
    where: { source: "jellyfin", serverInstance: instance, active: true },
  });

  return NextResponse.json({
    serverInstance: instance,
    httpStatus,
    fetchError,
    responseShape,
    rawCount: items.length,
    processedCount: processed.length,
    skippedCount: skipped.length,
    dbCount,
    gap: processed.length - dbCount,
    skipped,
    processed: processed.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isAdmin: u.isAdmin,
      isDisabled: u.isDisabled,
      isHidden: u.isHidden,
      downloadsEnabled: u.downloadsEnabled,
    })),
  });
});

// The raw /Users answer, with no query params so nothing is filtered on the
// server side. Jellyfin's GET /Users needs admin ("elevated") rights: the real
// user sync's own headers (jellyfin.ts), so the diagnosis sees what it sees and
// can't drift from it when the client identity changes.
async function fetchUsers(base: string, apiKey: string): Promise<{ httpStatus: number; rawBody: unknown; fetchError: string | null }> {
  let httpStatus = 0;
  try {
    const res = await safeFetchAdminConfigured(`${base}/Users`, {
      headers: jellyfinAdminHeaders(apiKey),
      timeoutMs: 30_000,
    });
    httpStatus = res.status;
    return { httpStatus, rawBody: await res.json(), fetchError: null };
  } catch (err) {
    // A coarse kind, never the message: a SafeFetchError's text names the
    // admin-configured server's scheme, host and port (and on the SSRF-policy
    // branches its resolved address), and this route admits a MANAGE_USERS
    // delegate who is not shown the server address anywhere else.
    const fetchError = err instanceof SafeFetchError
      ? `fetch:${err.reason}`
      : err instanceof Error ? err.name : "error";
    return { httpStatus, rawBody: null, fetchError };
  }
}

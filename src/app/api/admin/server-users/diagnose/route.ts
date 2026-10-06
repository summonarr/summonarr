import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Raw Jellyfin user shape — every field optional so no user is dropped while parsing.
interface RawJellyfinUser {
  Id?: string | null;
  Name?: string | null;
  Email?: string | null;
  HasPassword?: boolean;
  Policy?: {
    IsAdministrator?: boolean;
    IsDisabled?: boolean;
    IsHidden?: boolean;
    EnableContentDownloading?: boolean;
  } | null;
}

// Jellyfin's GET /Users needs admin ("elevated") rights. From 10.9 on, the
// X-MediaBrowser-Token header alone is not enough; the full
// `Authorization: MediaBrowser ...` header is required. These headers mirror
// the real /Users fetch so the diagnosis sees what the user sync sees.
function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    "Authorization": `MediaBrowser Client="Summonarr", Device="Summonarr", DeviceId="summonarr-server", Version="1.0", Token="${apiKey}"`,
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

type SkipReason = "missing-id" | "empty-name" | "missing-name" | "no-policy";

function maskEmail(email: string | null | undefined): string | null {
  return email ? `${email.slice(0, 3)}…` : null;
}

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

  // Plain fetch with no query params, so nothing is filtered on the server side.
  let httpStatus = 0;
  let rawBody: unknown = null;
  let fetchError: string | null = null;
  try {
    const res = await safeFetchAdminConfigured(`${base}/Users`, {
      headers: jellyfinHeaders(apiKey),
      timeoutMs: 30_000,
    });
    httpStatus = res.status;
    rawBody = await res.json();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Parse however the body comes back
  let items: RawJellyfinUser[] = [];
  let responseShape = "unknown";
  if (Array.isArray(rawBody)) {
    items = rawBody as RawJellyfinUser[];
    responseShape = "array";
  } else if (rawBody && typeof rawBody === "object" && "Items" in rawBody && Array.isArray((rawBody as { Items: unknown }).Items)) {
    items = (rawBody as { Items: RawJellyfinUser[] }).Items;
    responseShape = "QueryResult{Items}";
  } else if (rawBody !== null) {
    responseShape = `unexpected:${typeof rawBody}`;
  }

  // Flag every user the sync would skip, and say why, so the admin can see it.
  // Reasons are stable machine codes (not prose, not translated): this route is
  // curl/OpenAPI-only and the codes are what a bug report gets grepped for.
  const breakdown = items.map((u) => {
    const issues: SkipReason[] = [];
    if (!u.Id) issues.push("missing-id");
    if (!u.Name) issues.push(u.Name === "" ? "empty-name" : "missing-name");
    if (!u.Policy) issues.push("no-policy");
    return {
      id: u.Id ?? null,
      name: u.Name ?? null,
      // Masked for skipped AND processed rows alike — the skipped ones are
      // exactly what gets pasted into a bug report.
      email: maskEmail(u.Email),
      isAdmin: u.Policy?.IsAdministrator ?? null,
      isDisabled: u.Policy?.IsDisabled ?? null,
      isHidden: u.Policy?.IsHidden ?? null,
      downloadsEnabled: u.Policy?.EnableContentDownloading ?? null,
      wouldBeSkipped: issues.length > 0,
      skipReasons: issues,
    };
  });

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

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";

// Raw Jellyfin user shape — intentionally permissive so nothing is filtered
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

function jellyfinHeaders(apiKey: string): Record<string, string> {
  return {
    "X-MediaBrowser-Token": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

export async function GET() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);

  if (!urlRow?.value || !keyRow?.value) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 400 });
  }

  const base = urlRow.value.replace(/\/$/, "");

  // Fetch with no query params — baseline
  let httpStatus = 0;
  let rawBody: unknown = null;
  let fetchError: string | null = null;
  try {
    const res = await safeFetchAdminConfigured(`${base}/Users`, {
      headers: jellyfinHeaders(keyRow.value),
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

  // Categorise every item so the user can see exactly what's being filtered
  const breakdown = items.map((u) => {
    const issues: string[] = [];
    if (!u.Id) issues.push("missing Id");
    if (!u.Name) issues.push(u.Name === "" ? "empty Name" : "missing Name");
    if (!u.Policy) issues.push("no Policy object");
    return {
      id: u.Id ?? null,
      name: u.Name ?? null,
      email: u.Email ?? null,
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

  const dbCount = await prisma.mediaServerUser.count({ where: { source: "jellyfin" } });

  return NextResponse.json({
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
      email: u.email ? `${u.email.slice(0, 3)}…` : null,
      isAdmin: u.isAdmin,
      isDisabled: u.isDisabled,
      isHidden: u.isHidden,
      downloadsEnabled: u.downloadsEnabled,
    })),
  });
}

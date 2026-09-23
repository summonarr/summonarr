import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [users, autoDisableRow] = await Promise.all([
    prisma.mediaServerUser.findMany({
      where: { active: true }, // hide soft-deleted (departed) server users from active management
      // Safety bound so a pathologically large media server can't return an
      // unbounded row set to the admin client. Far above any realistic active
      // user count; a deployment exceeding it needs real pagination.
      take: 10_000,
      select: {
        id: true,
        source: true,
        // Multi-server support — distinguishes same-named/same-sourceUserId rows
        // across two independently-configured servers of the same provider.
        serverInstance: true,
        sourceUserId: true,
        username: true,
        email: true,
        thumbUrl: true,
        downloadsEnabled: true,
        isServerAdmin: true,
        userId: true,
        manualUserLink: true, // admin pinned this binding — automatic linking skips the row
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ source: "asc" }, { username: "asc" }],
    }),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" }, select: { value: true } }),
  ]);

  // Returned as an object (not a bare array) so the "auto-disable downloads for
  // new Jellyfin users" flag travels with the list — the native admin client
  // reads and toggles it.
  return NextResponse.json({ users, autoDisableNew: autoDisableRow?.value === "true" });
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ autoDisableNew?: boolean }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (body.autoDisableNew !== undefined) {
    if (typeof body.autoDisableNew !== "boolean") {
      return NextResponse.json({ error: "autoDisableNew must be a boolean" }, { status: 400 });
    }
    const newValue = body.autoDisableNew ? "true" : "false";

    // Audit this write by hand: the Setting decides whether newly found
    // Jellyfin users lose download rights, and it is saved here rather than
    // through /api/settings, so that route's audit trail never sees it.
    const before = await prisma.setting.findUnique({
      where: { key: "downloadAutoDisableNew" },
      select: { value: true },
    });
    await prisma.setting.upsert({
      where: { key: "downloadAutoDisableNew" },
      create: { key: "downloadAutoDisableNew", value: newValue },
      update: { value: newValue },
    });
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "SETTINGS_CHANGE",
      target: "settings:downloadAutoDisableNew",
      details: {
        key: "downloadAutoDisableNew",
        before: { value: before?.value ?? null },
        after: { value: newValue },
      },
      ...auditContext(req, session),
    });
  }

  return NextResponse.json({ ok: true });
});

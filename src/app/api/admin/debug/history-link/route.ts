import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/email-normalize";
import { isPurgedRow } from "@/lib/account-lifecycle";

// Play-history attribution counterpart to /api/admin/debug/arr-state: answers
// "why does this account see no watch history?" in one call.
//
// Every personal history surface (/watch-history, /my-stats, the export) funnels
// through resolveLinkedMediaServerUserIds in src/lib/my-watch-history.ts, which
// unions TWO matchers:
//   1. MediaServerUser.userId == the caller  (the FK — set by automatic linking
//      at ingest, by the hourly Jellyfin sync, or by an admin's manual link)
//   2. (source, sourceUserId) == the caller's OWN User.plexUserId/jellyfinUserId
//      — and ONLY for a row that is NOT manually pinned (`manualUserLink`).
//      Matcher 2 is automatic resolution, which guardrail 34 says must skip a
//      pinned row: an admin's manual UNLINK (userId=null) or re-assignment to a
//      DIFFERENT account still leaves this account's provider subject equal to
//      the row's sourceUserId, and the resolver deliberately refuses to hand the
//      history back on that equality. This dump must refuse it too, or it
//      reports history as visible on exactly the case the pin exists to hide.
// An empty union means an empty history page. This dump shows which matcher each
// MediaServerUser row would satisfy, so the reason is visible rather than guessed.
//
// GET /api/admin/debug/history-link?userId=<id>   (or ?email=<address>)
// Read-only — issues no writes.
export const GET = withAdmin(async (req, _ctx, _session) => {
  const sp = req.nextUrl.searchParams;
  const userId = sp.get("userId");
  const email = sp.get("email");
  if (!userId && !email) {
    return NextResponse.json({ error: "Pass ?userId= or ?email=" }, { status: 400 });
  }

  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : await prisma.user.findUnique({ where: { email: normalizeEmail(email!) } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Every server identity that could plausibly belong to this person: the ones
  // already linked, the ones matching their provider subject, and the ones
  // matching their email (the key automatic linking uses at ingest).
  const candidates = await prisma.mediaServerUser.findMany({
    where: {
      OR: [
        { userId: user.id },
        ...(user.plexUserId ? [{ source: "plex", sourceUserId: user.plexUserId }] : []),
        ...(user.jellyfinUserId ? [{ source: "jellyfin", sourceUserId: user.jellyfinUserId }] : []),
        ...(user.email ? [{ email: user.email }] : []),
      ],
    },
    select: {
      id: true, source: true, sourceUserId: true, username: true, email: true,
      userId: true, manualUserLink: true, active: true,
      _count: { select: { playHistory: true } },
    },
    orderBy: [{ source: "asc" }, { username: "asc" }],
  });

  const rows = candidates.map((r) => {
    const matchesFk = r.userId === user.id;
    // The raw subject equality, then the pin. Mirrors the resolver's
    // `{ source, sourceUserId, manualUserLink: false }` branches exactly — a
    // pinned row satisfies the equality but is NOT resolved (guardrail 34), and
    // the split is kept so the operator can see WHY a subject match did not fire.
    const subjectEquals =
      (r.source === "plex" && !!user.plexUserId && r.sourceUserId === user.plexUserId) ||
      (r.source === "jellyfin" && !!user.jellyfinUserId && r.sourceUserId === user.jellyfinUserId);
    const subjectSuppressedByPin = subjectEquals && r.manualUserLink;
    const matchesSubject = subjectEquals && !r.manualUserLink;
    // NOT a matcher in the read path — shown because it IS the key automatic
    // linking falls back to at ingest, so it explains whether the FK would heal
    // itself on this person's next watch.
    const emailWouldRelink = !!r.email && !!user.email && r.email === user.email;
    return {
      ...r,
      playHistoryRows: r._count.playHistory,
      _count: undefined,
      matchesFk,
      matchesSubject,
      subjectSuppressedByPin,
      visibleToUser: matchesFk || matchesSubject,
      emailWouldRelink,
    };
  });

  const visible = rows.filter((r) => r.visibleToUser);
  const orphaned = rows.filter((r) => !r.visibleToUser && r.playHistoryRows > 0);

  // An empty candidate set is the hardest case to read: it means no row matched
  // ANY key, so the targeted query above shows nothing at all and there is
  // nothing to reason from. Dump every server identity holding history so the
  // row that should have matched is visible — Plex reports the server OWNER's
  // sessions under a server-local account id (typically "1"), NOT their plex.tv
  // id, so the owner's row can carry a sourceUserId that no User.plexUserId will
  // ever equal. Bounded and read-only — and issued ONLY in that empty case: the
  // correlated PlayHistory count over 200 rows is the most expensive read on
  // this route, and when a candidate matched its result is never emitted.
  const allIdentities =
    rows.length > 0
      ? []
      : await prisma.mediaServerUser.findMany({
          take: 200,
          select: {
            id: true, source: true, sourceUserId: true, username: true, email: true,
            userId: true, manualUserLink: true, active: true, isServerAdmin: true,
            _count: { select: { playHistory: true } },
          },
          orderBy: [{ source: "asc" }, { username: "asc" }],
        });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      // The three identity columns the resolver depends on. A local-credentials
      // or OIDC account has NO provider subject, so matcher 2 can never fire for
      // it — the FK is its only route to its own history.
      plexUserId: user.plexUserId,
      jellyfinUserId: user.jellyfinUserId,
      hasProviderSubject: !!(user.plexUserId || user.jellyfinUserId),
      deactivatedAt: user.deactivatedAt,
      purgedAt: user.purgedAt,
      // A scrubbed row, by marker OR by shape (rows purged before `purgedAt`
      // existed carry only the tombstone email). Looking one of these up is the
      // classic wrong turn: it is the OLD, de-identified record, never the
      // account the person signs in with today — that is a separate row under
      // their real address, and it is the one to pass here.
      isPurgedTombstone: isPurgedRow(user),
    },
    resolvedMediaServerUserIds: visible.map((r) => r.id),
    visibleHistoryRows: visible.reduce((n, r) => n + r.playHistoryRows, 0),
    candidates: rows,
    // The actionable bit: server identities holding history that this account
    // canNOT see. Fix with the manual link (PATCH /api/admin/server-users/<id>
    // with { userId }), which sets the FK and pins it against automatic churn.
    orphanedWithHistory: orphaned.map((r) => ({
      mediaServerUserId: r.id,
      source: r.source,
      username: r.username,
      playHistoryRows: r.playHistoryRows,
      active: r.active,
      manualUserLink: r.manualUserLink,
      // true = the account's own provider subject matches this row, and the
      // ONLY thing hiding the history is the pin (manual unlink / re-assign).
      subjectSuppressedByPin: r.subjectSuppressedByPin,
      linkedToOtherUserId: r.userId,
      emailWouldRelink: r.emailWouldRelink,
    })),
    // Shown only when nothing matched — otherwise it's noise. Whichever of these
    // is the caller's identity is the one to hand to
    // PATCH /api/admin/server-users/<id> with { userId }.
    allServerIdentities:
      rows.length > 0
        ? undefined
        : allIdentities.map((r) => ({
            mediaServerUserId: r.id,
            source: r.source,
            sourceUserId: r.sourceUserId,
            username: r.username,
            email: r.email,
            isServerAdmin: r.isServerAdmin,
            active: r.active,
            linkedToUserId: r.userId,
            manualUserLink: r.manualUserLink,
            playHistoryRows: r._count.playHistory,
          })),
  });
});

import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { NotificationList, type NotificationListItem } from "@/components/notifications/notification-list";

export const dynamic = "force-dynamic";

// Full notification history (the header bell shows only the recent page).
// requireAppSession() is the per-page DB-checked login gate — the (app) layout's gate
// can be skipped via a client-supplied RSC router state tree, so each page enforces the
// login wall itself (guardrail 29, src/lib/require-app-session.ts). It also supplies the
// caller's own id.
export default async function NotificationsPage() {
  const session = await requireAppSession();
  const [rows, total] = session
    ? await Promise.all([
        prisma.notification.findMany({
          where: { userId: session.user.id },
          select: { id: true, type: true, title: true, body: true, tmdbId: true, mediaType: true, posterPath: true, readAt: true, createdAt: true },
          // Must match the API cursor ordering in /api/notifications (createdAt
          // desc, id desc) so the client's keyset cursor cannot skip a same-timestamp
          // row at the first-page boundary — sync createMany writes a batch of
          // notifications that share one transaction timestamp.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 30,
        }),
        prisma.notification.count({ where: { userId: session.user.id } }),
      ])
    : [[], 0];

  const items: NotificationListItem[] = rows.map((n) => ({
    ...n,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  }));

  return (
    <div>
      <PageHeader title="Notifications" />
      <div style={{ marginTop: 16 }}>
        <NotificationList initialItems={items} initialTotal={total} />
      </div>
    </div>
  );
}

import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { NotificationList, type NotificationListItem } from "@/components/notifications/notification-list";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { localizeStoredTitles } from "@/lib/tmdb-localize";
import { renderNotification } from "@/lib/notification-render";

export const dynamic = "force-dynamic";

// Full notification history (the header bell shows only the recent page).
// requireAppSession() is the per-page DB-checked login gate — the (app) layout's gate
// can be skipped via a client-supplied RSC router state tree, so each page enforces the
// login wall itself (guardrail 29, src/lib/require-app-session.ts). It also supplies the
// caller's own id.
export default async function NotificationsPage() {
  const session = await requireAppSession();
  const t = await getTranslator();
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      select: { id: true, type: true, title: true, body: true, tmdbId: true, mediaType: true, posterPath: true, readAt: true, createdAt: true, data: true },
      // Must match the API cursor ordering in /api/notifications (createdAt
      // desc, id desc) so the client's keyset cursor cannot skip a same-timestamp
      // row at the first-page boundary — sync createMany writes a batch of
      // notifications that share one transaction timestamp.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30,
    }),
    prisma.notification.count({ where: { userId: session.user.id } }),
  ]);

  // Rendered in the viewer's language from the row's stored data, exactly as
  // GET /api/notifications does for the pages loaded after this one.
  const localized = await localizeStoredTitles(rows, await getLocale());
  const items: NotificationListItem[] = localized.map(({ data, ...n }) => ({
    ...n,
    ...renderNotification({ ...n, data }, t),
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  }));

  return (
    <div className="ds-page-enter">
      <PageHeader title={t("personal.notifications.title")} subtitle={t("personal.notifications.subtitle")} />
      <NotificationList initialItems={items} initialTotal={total} />
    </div>
  );
}

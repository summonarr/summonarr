import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { enabledArrInstances } from "@/lib/arr-admin";
import { parseCalendarView } from "@/lib/arr-calendar-days";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { ArrCalendar } from "@/components/admin/arr-calendar";

export const dynamic = "force-dynamic";

type Param = string | string[] | undefined;
const one = (v: Param): string | undefined => (typeof v === "string" ? v : undefined);

// ADMIN-only, re-decided here with the DB-checked authActive() (guardrail 29 —
// the (app)/admin layout admits delegated managers too). The calendar loads
// client-side because it reads Radarr/Sonarr live and its weeks are in the
// viewer's time zone; this render passes the instance list, the view from the
// URL (?week=YYYY-MM-DD&filter=&type=&instance=&unmonitored=1, each checked)
// and the server's "now" (guardrail 16 — the client never reads the clock
// while rendering; it turns `week` into a local day only after mount).
export default async function ArrCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: Param; filter?: Param; type?: Param; instance?: Param; unmonitored?: Param }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const instances = await enabledArrInstances();
  const sp = await searchParams;
  const initialView = parseCalendarView(
    { week: one(sp.week), filter: one(sp.filter), type: one(sp.type), instance: one(sp.instance), unmonitored: one(sp.unmonitored) },
    instances.map((i) => `${i.service}:${i.slug}`),
  );
  // Next keeps a page's client state across a navigation that changes only the
  // query (the nav link to the bare page, another ?week=), so the calendar
  // would keep its old window and filters while the URL moved on. Every server
  // render carries a new `today`, so keying on it starts each one from the
  // URL's view.
  const today = new Date().toISOString();
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminArr.calendar.title")} subtitle={t("adminArr.calendar.subtitle")} />
      <ArrCalendar key={today} instances={instances} today={today} initialView={initialView} />
    </div>
  );
}

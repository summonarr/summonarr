import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { enabledArrInstances } from "@/lib/arr-admin";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { ArrCalendar } from "@/components/admin/arr-calendar";

export const dynamic = "force-dynamic";

// ADMIN-only, re-decided here with the DB-checked authActive() (guardrail 29 —
// the (app)/admin layout admits delegated managers too). The calendar loads
// client-side because it reads Radarr/Sonarr live and its weeks are in the
// viewer's time zone; this render passes the instance list and the server's
// "now" (guardrail 16 — the client never reads the clock while rendering).
export default async function ArrCalendarPage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const instances = await enabledArrInstances();
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminArr.calendar.title")} subtitle={t("adminArr.calendar.subtitle")} />
      <ArrCalendar instances={instances} today={new Date().toISOString()} />
    </div>
  );
}

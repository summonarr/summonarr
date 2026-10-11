import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { NeverWatchedReport } from "@/components/admin/never-watched-report";
import type { NwLevel, NwStateFilter } from "@/lib/never-watched";

export const dynamic = "force-dynamic";

const LEVELS: readonly NwLevel[] = ["title", "season"];
const STATES: readonly NwStateFilter[] = ["never", "possible", "unknown", "all"];

// ADMIN-only. The (app)/admin layout admits delegated managers too, so the role
// decision is re-made here with the DB-checked authActive() (guardrail 29). The
// report loads client-side: it is a whole-library computation with a Radarr/
// Sonarr listing behind it, and the table is paged on the server.
export default async function NeverWatchedPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string | string[]; state?: string | string[] }>;
}) {
  await requireFeature("feature.admin.neverWatched");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const sp = await searchParams;
  const level = typeof sp.level === "string" && (LEVELS as readonly string[]).includes(sp.level) ? (sp.level as NwLevel) : "title";
  const state = typeof sp.state === "string" && (STATES as readonly string[]).includes(sp.state) ? (sp.state as NwStateFilter) : "never";

  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminManage.neverWatched.title")} subtitle={t("adminManage.neverWatched.subtitle")} />
      <NeverWatchedReport initialLevel={level} initialState={state} />
    </div>
  );
}

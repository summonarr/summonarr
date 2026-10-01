import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { PageHeader } from "@/components/ui/design";
import { LibraryCleanup } from "@/components/admin/library-cleanup";

export const dynamic = "force-dynamic";

// ADMIN-only: this page deletes media. The (app)/admin layout admits delegated
// managers too, so the role decision is re-made here with the DB-checked
// authActive() (guardrail 29). The report itself loads client-side because it
// makes live Radarr/Sonarr calls.
export default async function LibraryCleanupPage() {
  await requireFeature("feature.admin.cleanup");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Library Cleanup"
        subtitle="Find what nobody watches, and remove it from Radarr/Sonarr after a dry run"
      />
      <LibraryCleanup />
    </div>
  );
}

import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { OpenApiViewer } from "@/components/admin/openapi-viewer";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  // Enforce the flag on the PAGE, not just the nav — hiding the link alone would
  // leave the URL live, so the toggle would not actually disable anything.
  await requireFeature("feature.admin.apiDocs");
  // authActive() already rejects an expired or revoked session (guardrail 29), so
  // no separate isTokenExpired() — same gate as the sibling admin pages.
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.apiDocs.title")}
        subtitle={t("adminManage.apiDocs.subtitle")}
      />
      <div
        className="overflow-hidden"
        style={{
          background: "var(--ds-bg-2)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        <OpenApiViewer />
      </div>
    </div>
  );
}

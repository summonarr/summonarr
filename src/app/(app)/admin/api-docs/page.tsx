import { authActive, isTokenExpired } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { OpenApiViewer } from "@/components/admin/openapi-viewer";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  // Enforce the flag on the PAGE, not just the nav — hiding the link alone would
  // leave the URL live, so the toggle would not actually disable anything.
  await requireFeature("feature.admin.apiDocs");
  const session = await authActive();
  if (!session || isTokenExpired(session) || !hasPermission(session.user.permissions, Permission.ADMIN)) {
    redirect("/");
  }

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="API Docs"
        subtitle="OpenAPI 3.0 reference for all Summonarr endpoints. Each request authenticates with your session cookie; use Copy as curl to call an endpoint from a terminal."
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

import { authActive, isTokenExpired } from "@/lib/auth";
import { redirect } from "next/navigation";
import { OpenApiViewer } from "@/components/admin/openapi-viewer";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  const session = await authActive();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
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

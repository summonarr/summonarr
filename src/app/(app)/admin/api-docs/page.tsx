import { auth, isTokenExpired } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SwaggerUIClient } from "@/components/admin/swagger-ui-client";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  const session = await auth();
  if (
    !session ||
    isTokenExpired(session) ||
    (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")
  ) {
    redirect("/");
  }

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="API Docs"
        subtitle="OpenAPI 3.0 reference for all Summonarr endpoints. Use the Authorize button to attach your session cookie before trying requests."
      />
      <div
        className="overflow-hidden"
        style={{
          background: "var(--ds-bg-inset)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        <SwaggerUIClient />
      </div>
    </div>
  );
}

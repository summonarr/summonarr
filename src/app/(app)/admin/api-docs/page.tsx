import { auth, isTokenExpired } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SwaggerUIClient } from "@/components/admin/swagger-ui-client";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  const session = await auth();
  if (!session || isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) {
    redirect("/");
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">API Docs</h1>
        <p className="text-zinc-400 text-sm">
          OpenAPI 3.0 reference for all Summonarr endpoints. Use the Authorize button to attach your session cookie
          before trying requests.
        </p>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        <SwaggerUIClient />
      </div>
    </div>
  );
}

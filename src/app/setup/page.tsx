import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
import Link from "next/link";
import { SetupForm } from "./setup-form";

// First-run wizard; inaccessible once any user exists so the admin account can't be hijacked
export default async function SetupPage() {
  const count = await prisma.user.count();
  if (count > 0) redirect("/login");

  const siteTitleRow = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
  const siteTitle = siteTitleRow?.value || "Summonarr";

  const jellyfinEnabled = !!process.env.JELLYFIN_URL;
  const oidcEnabled = !!(
    process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET
  );
  const oidcName = process.env.OIDC_DISPLAY_NAME || "SSO";
  const hasExternalProvider = jellyfinEnabled || oidcEnabled;

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-indigo-600 flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Welcome to {siteTitle}</h1>
          <p className="text-zinc-400 text-sm mt-1 text-center">
            Create your admin account to get started.
          </p>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8">
          <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
            <span className="text-indigo-400 text-xs font-medium">
              First user automatically becomes administrator
            </span>
          </div>
          <SetupForm />

          {hasExternalProvider && (
            <>
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs uppercase tracking-wider text-zinc-500">or</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
              <p className="text-center text-xs text-zinc-500 mb-3">
                Sign in with your existing account — the first user becomes administrator automatically.
              </p>
              <Link
                href="/login"
                className="block text-center w-full rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium py-2.5 transition-colors"
              >
                Sign in with {jellyfinEnabled && oidcEnabled ? "Jellyfin or " + oidcName : jellyfinEnabled ? "Jellyfin" : oidcName}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

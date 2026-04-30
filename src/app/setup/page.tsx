import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
import { SetupShell } from "./setup-shell";

const MIN_BACKUP_PASSWORD_LEN = 12;

// First-run wizard; inaccessible once any user exists so the admin account can't be hijacked
export default async function SetupPage() {
  const count = await prisma.user.count();
  if (count > 0) redirect("/login");

  const siteTitleRow = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
  const siteTitle = siteTitleRow?.value || "Summonarr";

  const backupPassword = process.env.BACKUP_DB_PASSWORD ?? "";
  const importAvailable = backupPassword.length >= MIN_BACKUP_PASSWORD_LEN;

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

        <SetupShell importAvailable={importAvailable} />
      </div>
    </div>
  );
}

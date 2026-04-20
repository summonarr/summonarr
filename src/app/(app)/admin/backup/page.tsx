import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { BackupUI } from "@/components/admin/backup-ui";

export const dynamic = "force-dynamic";

export default async function BackupPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Backup &amp; Restore</h1>
        <p className="text-zinc-400 text-sm">Export and import your Summonarr database</p>
      </div>

      <div className="space-y-6 max-w-2xl lg:max-w-4xl">
        <Card className="bg-zinc-900 border-zinc-800 p-6">
          <div className="mb-5">
            <h2 className="font-semibold text-white text-lg">Database Export</h2>
            <p className="text-sm text-zinc-500 mt-0.5">
              Download a complete encrypted SQL dump of every table including settings, accounts, library caches, audit logs, and password hashes. Use this for full server migration or disaster recovery.
            </p>
          </div>
          <BackupUI mode="db-export" />
        </Card>

        <Card className="bg-zinc-900 border-zinc-800 p-6">
          <div className="mb-5">
            <h2 className="font-semibold text-white text-lg">Database Restore</h2>
            <p className="text-sm text-zinc-500 mt-0.5">
              Restore from a previously exported encrypted SQL backup file. Duplicate rows are automatically skipped.
            </p>
          </div>
          <BackupUI mode="db-import" />
        </Card>
      </div>
    </div>
  );
}

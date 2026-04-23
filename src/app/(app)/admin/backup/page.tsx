import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { BackupUI } from "@/components/admin/backup-ui";
import { requireFeature } from "@/lib/features";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

export default async function BackupPage() {
  await requireFeature("feature.admin.backup");
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Backup & Restore"
        subtitle="Export and import your Summonarr database"
      />

      <div
        className="flex flex-col max-w-2xl lg:max-w-4xl"
        style={{ gap: 20 }}
      >
        <BackupSection
          title="Database Export"
          description="Download a complete encrypted SQL dump of every table including settings, accounts, library caches, audit logs, and password hashes. Use this for full server migration or disaster recovery."
        >
          <BackupUI mode="db-export" />
        </BackupSection>

        <BackupSection
          title="Database Restore"
          description="Restore from a previously exported encrypted SQL backup file. Duplicate rows are automatically skipped."
        >
          <BackupUI mode="db-import" />
        </BackupSection>
      </div>
    </div>
  );
}

function BackupSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 22,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <h2
          className="font-semibold"
          style={{
            fontSize: 15,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            margin: 0,
          }}
        >
          {title}
        </h2>
        <p
          style={{
            fontSize: 12,
            color: "var(--ds-fg-muted)",
            margin: "4px 0 0",
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

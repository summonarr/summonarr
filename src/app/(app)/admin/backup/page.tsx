import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Lock, Download, Upload } from "lucide-react";
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
        subtitle="Export · Import · Encrypted at rest"
      />

      <div
        className="flex items-start"
        style={{
          gap: 12,
          padding: "14px 16px",
          marginBottom: 20,
          background: "var(--ds-accent-soft)",
          border: "1px solid color-mix(in oklab, var(--ds-accent) 30%, var(--ds-border))",
          borderRadius: 8,
        }}
      >
        <Lock
          style={{
            width: 18,
            height: 18,
            color: "var(--ds-accent)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ fontSize: 12.5, color: "var(--ds-fg-muted)", lineHeight: 1.6 }}>
          Full-DB backups are always encrypted with the server&apos;s{" "}
          <code
            className="ds-mono"
            style={{
              background: "var(--ds-bg-3)",
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: 11,
              color: "var(--ds-fg)",
            }}
          >
            BACKUP_DB_PASSWORD
          </code>{" "}
          environment variable (AES-256). Only someone with shell access to the server can decrypt the resulting
          file. Plain SQL dumps are rejected on import.
        </div>
      </div>

      <div
        className="grid grid-cols-1 lg:grid-cols-2 max-w-4xl"
        style={{ gap: 14 }}
      >
        <BackupCard
          icon={<Download style={{ width: 16, height: 16 }} />}
          title="Database Export"
          tag="Full DB · Encrypted · One file"
          description="Download a complete encrypted SQL dump of every table — settings, accounts, library caches, audit logs, password hashes. Use this for full server migration or disaster recovery."
        >
          <BackupUI mode="db-export" />
        </BackupCard>

        <BackupCard
          icon={<Upload style={{ width: 16, height: 16 }} />}
          title="Database Restore"
          tag="From *.sql.enc · Drop-in replacement"
          description="Restore from a previously exported encrypted backup. Every table in the dump is truncated and re-inserted atomically — the database returns to the exact state at backup time. Failure rolls back."
        >
          <BackupUI mode="db-import" />
        </BackupCard>
      </div>

      <div
        className="max-w-4xl"
        style={{
          marginTop: 20,
          padding: "14px 18px",
          border: "1px dashed var(--ds-border)",
          borderRadius: 8,
        }}
      >
        <div
          className="ds-mono uppercase"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            letterSpacing: "0.06em",
            marginBottom: 8,
          }}
        >
          Operational notes
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            fontSize: 12.5,
            color: "var(--ds-fg-muted)",
            lineHeight: 1.8,
          }}
        >
          <li>Exports are synchronous; large DBs may take up to 30s to generate.</li>
          <li>Restore is destructive: every listed table is truncated before re-insert, all in a single transaction. Any failure rolls back the entire restore — no half-restored state.</li>
          <li>Schema migrations are <em>not</em> run on import. Restore only into a server running the same version.</li>
          <li>
            Both actions emit{" "}
            <code
              className="ds-mono"
              style={{
                background: "var(--ds-bg-3)",
                padding: "1px 5px",
                borderRadius: 3,
                fontSize: 11,
                color: "var(--ds-fg)",
              }}
            >
              BACKUP_EXPORT
            </code>{" "}
            /{" "}
            <code
              className="ds-mono"
              style={{
                background: "var(--ds-bg-3)",
                padding: "1px 5px",
                borderRadius: 3,
                fontSize: 11,
                color: "var(--ds-fg)",
              }}
            >
              BACKUP_IMPORT
            </code>{" "}
            audit events.
          </li>
        </ul>
      </div>
    </div>
  );
}

function BackupCard({
  icon,
  title,
  tag,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tag: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 20,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex items-center justify-center shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--ds-bg-3)",
            color: "var(--ds-fg)",
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            className="font-semibold"
            style={{
              fontSize: 14,
              letterSpacing: "-0.01em",
              color: "var(--ds-fg)",
              margin: 0,
            }}
          >
            {title}
          </h2>
          <p
            className="ds-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              letterSpacing: "0.06em",
              margin: "2px 0 0",
            }}
          >
            {tag}
          </p>
        </div>
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: "var(--ds-fg-muted)",
          margin: 0,
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>
      {children}
    </section>
  );
}

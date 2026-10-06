import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { Lock, Download, Upload } from "@/components/icons";
import { BackupUI } from "@/components/admin/backup-ui";
import { requireFeature } from "@/lib/features";
import { PageHeader } from "@/components/ui/design";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function BackupPage() {
  await requireFeature("feature.admin.backup");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  // Mirrors the db-export route's MIN_BACKUP_PASSWORD_LEN gate (it answers 503
  // below this), so the card can say "not configured" before a click opens a tab
  // of raw JSON. Read on the server only — the value itself never leaves here.
  const exportReady = (process.env.BACKUP_DB_PASSWORD ?? "").length >= 12;

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.backup.title")}
        subtitle={t("adminManage.backup.subtitle")}
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
            color: "var(--ds-accent-text)",
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ fontSize: 12.5, color: "var(--ds-fg-muted)", lineHeight: 1.6 }}>
          {t("adminManage.backup.notice.before")}{" "}
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
          {t("adminManage.backup.notice.after")}
        </div>
      </div>

      <div
        className="grid grid-cols-1 lg:grid-cols-2 max-w-4xl"
        style={{ gap: 14 }}
      >
        <BackupCard
          icon={<Download style={{ width: 16, height: 16 }} />}
          title={t("adminManage.backup.export.title")}
          tag={t("adminManage.backup.export.tag")}
          description={t("adminManage.backup.export.description")}
        >
          <BackupUI mode="db-export" exportReady={exportReady} />
        </BackupCard>

        <BackupCard
          icon={<Upload style={{ width: 16, height: 16 }} />}
          title={t("adminManage.backup.restore.title")}
          tag={t("adminManage.backup.restore.tag")}
          description={t("adminManage.backup.restore.description")}
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
          {t("adminManage.backup.notes.title")}
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
          <li>{t("adminManage.backup.notes.sync")}</li>
          <li>{t("adminManage.backup.notes.destructive")}</li>
          <li>{t("adminManage.backup.notes.migrations")}</li>
          <li>
            {t("adminManage.backup.notes.auditBefore")}{" "}
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
            {t("adminManage.backup.notes.auditAfter")}
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
        borderRadius: 8,
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

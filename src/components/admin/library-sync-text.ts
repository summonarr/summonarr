// The result line shared by the Re-sync Libraries and Initial DB Fill buttons:
// one "<server> <outcome>" part per configured server
// (src/lib/client/library-sync.ts runs them).
import type { Translator } from "@/lib/i18n/translate";
import { librarySyncLabel, type LibrarySyncOutcome, type LibrarySyncServer } from "@/lib/client/library-sync";

export function librarySyncText(server: LibrarySyncServer, outcome: LibrarySyncOutcome, t: Translator, locale: string): string {
  const label = librarySyncLabel(server);
  switch (outcome.kind) {
    case "synced":
      return `${label} ${t("adminManage.library.btn.items", { count: outcome.count, formatted: outcome.count.toLocaleString(locale) })}`;
    case "running":
      return `${label} ${t("adminManage.library.btn.alreadyRunning")}`;
    case "noAnswer":
      return `${label} ${t("adminManage.library.btn.noAnswer")}`;
    case "failed":
      return `${label} ${outcome.error ?? t("adminManage.library.btn.failedStatus", { status: outcome.status })}`;
  }
}

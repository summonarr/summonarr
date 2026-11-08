// The admin restore's answer, as the backup page shows it (backup-ui.tsx): the
// uploader's completion body checked field by field. The body is the server's,
// but a malformed summary (a missing count) used to reach the KPI grid as is
// and crash the section on `value.toLocaleString`. Pure; tested in
// tests/backup-import-result.test.mts.
import { check, v } from "@/lib/validate";

export type ImportSummary = { total: number; executed: number; skipped: number; errors: number };

export type ImportResult = {
  ok: boolean;
  summary?: ImportSummary;
  errors?: string[];
  error?: string;
  warning?: string;
};

const Summary = v.object({ total: v.number(), executed: v.number(), skipped: v.number(), errors: v.number() });

/** The fields of a completed restore's body the page renders, each kept only when it has the right shape. */
export function importResultFrom(data: Record<string, unknown>): ImportResult {
  const summary = check(Summary, data.summary);
  const errors = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === "string") : null;
  return {
    ok: data.ok === true,
    ...(summary.ok ? { summary: summary.value } : {}),
    ...(errors ? { errors } : {}),
    ...(typeof data.warning === "string" && data.warning ? { warning: data.warning } : {}),
  };
}

import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isCronAuthorized } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { expectedSchemaColumns } from "@/lib/schema-check";

// Whether the database has every table and column of the schema this build was
// generated from (schema-check.ts). A missing one means a `db push` was
// skipped or refused.
//
// withAdmin requires an admin session. The extra isCronAuthorized check does
// NOT demand the cron token too: for an admin it re-checks the session and, for
// a cookie session, adds a same-origin check. A bare
// `Bearer <CRON_SECRET>` never gets this far — withAdmin rejects it first (401).
export const GET = withAdmin(async (request, _ctx, _session) => {
  const t = translatorForRequest(request);
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }

  const rows = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;

  const actual: Record<string, string[]> = {};
  for (const row of rows) {
    (actual[row.table_name] ??= []).push(row.column_name);
  }

  const results: Record<string, { ok: boolean; missing: string[]; columns: string[] }> = {};
  for (const [table, expected] of Object.entries(expectedSchemaColumns())) {
    const cols    = actual[table] ?? [];
    const present = new Set(cols);
    const missing = expected.filter((c) => !present.has(c));
    results[table] = { ok: missing.length === 0, missing, columns: cols };
  }

  const allOk = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ allOk, tables: results, allTables: Object.keys(actual).sort() });
});

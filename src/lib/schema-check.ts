// What GET /api/admin/check-schema expects the database to have: every model
// and every scalar column of the schema this build was generated from. The
// generated client and `prisma db push` read the same prisma/schema.prisma, so
// a column the client knows and the database lacks means the push was skipped
// or refused — the multi-instance identity columns (guardrails 32/35) included,
// which sit inside @@id/@@unique keys and fail every scoped write when missing.
//
// Read from the client, never a hand-kept list: a list drifted from the schema
// as columns were added, and checked only the columns someone remembered.
// Model and field names are the table and column names because the schema
// maps none of them (no @map / @@map — tests/check-schema-route.test.mts pins
// that); a mapped name would need the mapped one here.
import { Prisma } from "@/generated/prisma";

export function expectedSchemaColumns(): Record<string, string[]> {
  // The generated namespace holds one `<Model>ScalarFieldEnum` per model.
  const namespace = Prisma as unknown as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const model of Object.values(Prisma.ModelName)) {
    const fields = namespace[`${model}ScalarFieldEnum`];
    if (fields && typeof fields === "object") {
      out[model] = Object.values(fields).filter((f): f is string => typeof f === "string");
    }
  }
  return out;
}

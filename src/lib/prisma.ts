import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { SETTINGS_SENSITIVE_KEYS_SET } from "@/lib/settings-sensitive-keys";

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient };

// Single source of truth — see src/lib/settings-sensitive-keys.ts. Previously
// this list was duplicated in prisma.ts and settings/route.ts; the lists drifted
// (six dead keys in this file with no counterpart in the writable schema), so
// any add-a-key change had to remember both spots.
const SENSITIVE_KEYS = SETTINGS_SENSITIVE_KEYS_SET;

// Account columns whose contents are OAuth secrets and must never sit at rest in plaintext.
const ACCOUNT_TOKEN_FIELDS = ["refresh_token", "access_token", "id_token"] as const;

function encryptAccountTokensInPlace(data: Record<string, unknown> | undefined | null): void {
  if (!data) return;
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const v = data[field];
    if (typeof v === "string" && v.length > 0) {
      data[field] = encryptToken(v);
    }
  }
}

function decryptAccountTokensInPlace(row: Record<string, unknown> | null | undefined): void {
  if (!row) return;
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const v = row[field];
    if (typeof v !== "string" || v.length === 0) continue;
    const id = typeof row.id === "string" ? row.id : "?";
    const label = `Account.${field} (id=${id})`;
    try {
      row[field] = decryptToken(v, label);
    } catch (err) {
      // A single un-decryptable column shouldn't take down whoever called findMany.
      // Surface enough context (account id + field) for an operator to re-link the account,
      // then null the field so the rest of the row can be returned to the caller.
      console.error(
        `[account-crypto] Decrypt failed for ${label} — re-link this account to recover. Original error:`,
        err instanceof Error ? err.message : err,
      );
      row[field] = null;
    }
  }
}

// Process-level set of Setting keys that have failed to decrypt at least once and
// haven't been successfully read since. The settings page reads this via
// getSettingDecryptFailures() to render a banner. Entries are cleared on the next
// successful read of the same key (which happens automatically on every findMany
// that includes the key after the operator re-saves it).
const settingDecryptFailures = new Set<string>();

export function getSettingDecryptFailures(): string[] {
  return [...settingDecryptFailures].sort();
}

// Per-row decrypt guard for Setting.value reads. A corrupt/wrong-key row would otherwise
// throw inside findMany and 500 every page that reads settings (e.g. /settings, /admin/*,
// the layout's feature-flag fetch). We log the affected key once per occurrence and substitute
// an empty string so the rest of the result set still flows through.
//
// Gated by SENSITIVE_KEYS to mirror the write side — non-sensitive keys (URLs, booleans,
// feature flags, threshold numbers) are stored plaintext by design, so calling decryptToken
// on them just emits a noisy "Legacy plaintext value" warning for values that never needed
// encryption. When the key is unknown (caller used `select: { value: true }` and didn't
// project `key`), we conservatively fall through to the decrypt path so a sensitive read
// still works — at the cost of a possible false-positive warning, which is the prior behavior.
function safeDecryptSettingValue(key: string | undefined, value: string): string {
  if (typeof key === "string" && !SENSITIVE_KEYS.has(key)) {
    return value;
  }
  const label = `Setting.${key ?? "?"}`;
  try {
    const result = decryptToken(value, label);
    if (typeof key === "string") settingDecryptFailures.delete(key);
    return result;
  } catch (err) {
    if (typeof key === "string") settingDecryptFailures.add(key);
    console.error(
      `[setting-crypto] Decrypt failed for key="${key ?? "?"}" — re-save this setting to recover. Original error:`,
      err instanceof Error ? err.message : err,
    );
    return "";
  }
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    // Small pool — this is a single-tenant app; keeping it low avoids exhausting Postgres connections
    max: 5,
  });

  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // Transparent at-rest crypto for both Setting rows (keyed by `key`) and Account rows
  // (specific OAuth-token columns). Reads decrypt, writes encrypt — callers always work in plaintext.
  return base.$extends({
    name: "setting-and-account-crypto",
    query: {
      setting: {
        async findUnique({ args, query }) {
          const row = await query(args);
          if (row && typeof row.value === "string") row.value = safeDecryptSettingValue(row.key, row.value);
          return row;
        },
        async findFirst({ args, query }) {
          const row = await query(args);
          if (row && typeof row.value === "string") row.value = safeDecryptSettingValue(row.key, row.value);
          return row;
        },
        async findMany({ args, query }) {
          const rows = await query(args);
          for (const r of rows) {
            if (typeof r.value === "string") r.value = safeDecryptSettingValue(r.key, r.value);
          }
          return rows;
        },
        async create({ args, query }) {
          // args.data may be a single object or (rare) Prisma's tuple shape — we only support the object form.
          const data = args.data as { key?: string; value?: string } | undefined;
          if (
            data &&
            typeof data.key === "string" &&
            SENSITIVE_KEYS.has(data.key) &&
            typeof data.value === "string" &&
            data.value.length > 0
          ) {
            data.value = encryptToken(data.value);
          }
          return query(args);
        },
        async update({ args, query }) {
          const where = args.where as { key?: string } | undefined;
          const data = args.data as { value?: unknown } | undefined;
          // Skip when the update doesn't touch `value` at all (e.g. metadata-only updates).
          const newValue = data && typeof data.value === "string" ? data.value : undefined;
          if (newValue !== undefined && newValue.length > 0) {
            const key = where?.key;
            if (typeof key === "string") {
              if (SENSITIVE_KEYS.has(key)) {
                (data as { value: string }).value = encryptToken(newValue);
              }
            } else {
              // Rare path: where uses something other than `key` (e.g. `id`). Read the row to
              // discover its key, then encrypt if needed. Best-effort — falls through on miss.
              const existing = await base.setting.findFirst({ where: args.where });
              if (existing && SENSITIVE_KEYS.has(existing.key)) {
                (data as { value: string }).value = encryptToken(newValue);
              }
            }
          }
          return query(args);
        },
        async upsert({ args, query }) {
          const where = args.where as { key?: string } | undefined;
          const key = where?.key;
          if (typeof key === "string" && SENSITIVE_KEYS.has(key)) {
            const create = args.create as { value?: unknown } | undefined;
            if (create && typeof create.value === "string" && create.value.length > 0) {
              (create as { value: string }).value = encryptToken(create.value);
            }
            const update = args.update as { value?: unknown } | undefined;
            if (update && typeof update.value === "string" && update.value.length > 0) {
              (update as { value: string }).value = encryptToken(update.value);
            }
          }
          return query(args);
        },
        async createMany({ args, query }) {
          const data = args.data as unknown;
          if (Array.isArray(data)) {
            for (const row of data) {
              if (
                row &&
                typeof row === "object" &&
                typeof (row as { key?: unknown }).key === "string" &&
                SENSITIVE_KEYS.has((row as { key: string }).key) &&
                typeof (row as { value?: unknown }).value === "string" &&
                ((row as { value: string }).value.length > 0)
              ) {
                (row as { value: string }).value = encryptToken((row as { value: string }).value);
              }
            }
          } else if (
            data &&
            typeof data === "object" &&
            typeof (data as { key?: unknown }).key === "string" &&
            SENSITIVE_KEYS.has((data as { key: string }).key) &&
            typeof (data as { value?: unknown }).value === "string" &&
            ((data as { value: string }).value.length > 0)
          ) {
            (data as { value: string }).value = encryptToken((data as { value: string }).value);
          }
          return query(args);
        },
        async updateMany({ args, query }) {
          // updateMany sets the same `data` on every matching row, so we can't know the
          // per-row `key` to consult SENSITIVE_KEYS. Forbid writes that touch `value` and
          // funnel callers to setting.update / setting.upsert where the extension runs.
          const data = (args as { data?: { value?: unknown } }).data;
          if (data && data.value !== undefined) {
            throw new Error(
              "[prisma] setting.updateMany with `value` is forbidden — use setting.update or setting.upsert so the encryption extension runs",
            );
          }
          return query(args);
        },
        async deleteMany({ args, query }) {
          return query(args);
        },
      },
      account: {
        async findUnique({ args, query }) {
          const row = await query(args);
          decryptAccountTokensInPlace(row as Record<string, unknown> | null);
          return row;
        },
        async findFirst({ args, query }) {
          const row = await query(args);
          decryptAccountTokensInPlace(row as Record<string, unknown> | null);
          return row;
        },
        async findMany({ args, query }) {
          const rows = await query(args);
          for (const r of rows) decryptAccountTokensInPlace(r as Record<string, unknown>);
          return rows;
        },
        async create({ args, query }) {
          encryptAccountTokensInPlace(args.data as Record<string, unknown> | undefined);
          return query(args);
        },
        async update({ args, query }) {
          encryptAccountTokensInPlace(args.data as Record<string, unknown> | undefined);
          return query(args);
        },
        async upsert({ args, query }) {
          encryptAccountTokensInPlace(args.create as Record<string, unknown> | undefined);
          encryptAccountTokensInPlace(args.update as Record<string, unknown> | undefined);
          return query(args);
        },
        // updateMany/createMany/deleteMany aren't wrapped by the extension's encrypt path:
        // they accept arrays of rows or a single `data` payload applied to many. Funnel
        // callers to the wrapped surface (create / update / upsert) so the encryption
        // step can't be silently bypassed for an OAuth token refresh batch.
        // Guards mirror setting.updateMany above. See guardrail 7a.
        async updateMany({ args, query }) {
          const data = (args as { data?: Record<string, unknown> }).data;
          if (data && (data.access_token !== undefined || data.refresh_token !== undefined || data.id_token !== undefined)) {
            throw new Error(
              "[prisma] account.updateMany with access_token/refresh_token/id_token is forbidden — use account.update or account.upsert so the encryption extension runs",
            );
          }
          return query(args);
        },
        async createMany({ args, query }) {
          const rows = (args as { data?: Record<string, unknown> | Record<string, unknown>[] }).data;
          const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
          for (const row of list) {
            if (row && (row.access_token !== undefined || row.refresh_token !== undefined || row.id_token !== undefined)) {
              throw new Error(
                "[prisma] account.createMany with access_token/refresh_token/id_token is forbidden — use account.create or account.upsert so the encryption extension runs",
              );
            }
          }
          return query(args);
        },
        async deleteMany({ args, query }) {
          return query(args);
        },
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// In dev, Next.js hot-reloads create new module instances; caching on globalThis prevents connection pool exhaustion
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

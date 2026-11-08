import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { isSensitiveSettingKey } from "@/lib/settings-sensitive-keys";
import { processSingleton } from "@/lib/process-singleton";

// The at-rest crypto behind the Prisma client extension (prisma.ts, guardrail
// 7a): Setting.value (by key), the Account OAuth-token columns, UserTotp.secret
// and NotificationAgent.secret. Reads decrypt, writes encrypt, and a write's
// returned row is decrypted too, so callers always work in plaintext.
//
// The three column models get their handlers from ONE factory
// (columnCryptoHandlers), so every model covers exactly the same operations:
// hand-written per-model copies are how one of them grew a hole before.
// Setting's sensitivity depends on the row's key, so its handlers are written
// out, but they share the same handler shape.

// Which Setting keys hold secrets is decided in ONE place:
// src/lib/settings-sensitive-keys.ts. Besides its fixed list, it matches the
// per-instance secret keys by pattern (e.g. radarr<Slug>ApiKey, plex<Slug>AdminToken),
// because admins invent those instance names at runtime.
const isSensitiveKey = isSensitiveSettingKey;

// Account columns whose contents are OAuth secrets and must never sit at rest in plaintext.
const ACCOUNT_TOKEN_FIELDS = ["refresh_token", "access_token", "id_token"] as const;

function encryptAccountTokensInPlace(data: Record<string, unknown> | undefined | null): void {
  if (!data) return;
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const v = data[field];
    if (typeof v === "string" && v.length > 0) {
      data[field] = encryptToken(v);
    } else if (v && typeof v === "object" && typeof (v as { set?: unknown }).set === "string") {
      // Prisma's `{ set: "…" }` update form is the same write — never plaintext.
      const set = (v as { set: string }).set;
      if (set.length > 0) (v as { set: string }).set = encryptToken(set);
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

// Encrypt the `value` of every sensitive Setting row in a create-shaped payload
// (single object or array). Shared by createMany and createManyAndReturn so the
// two can't drift.
function encryptSettingRowsInPlace(data: unknown): void {
  const list = Array.isArray(data) ? data : data ? [data] : [];
  for (const row of list) {
    if (
      row &&
      typeof row === "object" &&
      typeof (row as { key?: unknown }).key === "string" &&
      isSensitiveKey((row as { key: string }).key) &&
      typeof (row as { value?: unknown }).value === "string" &&
      (row as { value: string }).value.length > 0
    ) {
      (row as { value: string }).value = encryptToken((row as { value: string }).value);
    }
  }
}

// Process-level set of Setting keys that have failed to decrypt at least once and
// haven't been successfully read since. The settings page reads this via
// getSettingDecryptFailures() to render a banner. Entries are cleared on the next
// successful read of the same key (which happens automatically on every findMany
// that includes the key after the operator re-saves it) OR when the row is
// deleted through setting.delete / deleteMany — a deleted row is never read again, so
// without that hook the banner would name a key with no row and no re-save
// target until the process restarted (the "Disconnect Plex" and de-register-
// instance paths both recover from a corrupt token by deleting, not re-saving).
// Process-wide: this module is compiled into several server chunks, and a per-chunk
// Set meant getSettingDecryptFailures() showed the admin banner only the failures
// recorded by whichever chunk served that render.
const settingDecryptFailures = processSingleton(
  "prisma:settingDecryptFailures",
  () => new Set<string>(),
);

export function getSettingDecryptFailures(): string[] {
  return [...settingDecryptFailures].sort();
}

// Keys a `setting.deleteMany({ where })` targets, for releasing their decrypt-
// failure entries. Recognizes the two shapes every caller uses — `{ key: "x" }`
// and `{ key: { in: [...] } }` — and returns null for anything else (absent,
// or a filter on some other column) so the hook can't guess wrong: an
// unrecognized filter clears nothing rather than something it shouldn't.
export function settingKeysFromDeleteWhere(where: unknown): string[] | null {
  if (!where || typeof where !== "object") return null;
  const key = (where as { key?: unknown }).key;
  if (typeof key === "string") return [key];
  if (key && typeof key === "object") {
    const inList = (key as { in?: unknown }).in;
    if (Array.isArray(inList) && inList.every((k) => typeof k === "string")) return inList as string[];
  }
  return null;
}

// Finds the Setting key for a read whose row does not carry one. A caller that
// selects only the value (`select: { value: true }`) gets a row with no `key`,
// so warnings would print "Setting.?" and name no row an operator could re-save.
// The query's own `where.key` names it instead. Only a plain string counts: a
// `{ in: [...] }` filter matches many rows and would mislabel them all.
export function settingKeyFromArgs(args: unknown): string | undefined {
  const where = (args as { where?: unknown } | undefined)?.where;
  const key = (where as { key?: unknown } | undefined)?.key;
  return typeof key === "string" ? key : undefined;
}

// Per-row decrypt guard for Setting.value reads. A corrupt or wrong-key row would
// otherwise throw inside findMany and turn every page that reads settings into a
// 500 (e.g. /settings, /admin/*, the layout's feature-flag fetch). Instead we log
// the key, record it for the settings banner, and return "" so the other rows
// still come through.
//
// Only sensitive keys are decrypted, mirroring the write side: URLs, booleans,
// flags and numbers are stored as plain text on purpose, and decrypting them
// would just log a noisy "Legacy plaintext value" warning. When the key is
// unknown we still try to decrypt, so a sensitive read keeps working at the cost
// of a possible false warning.
function safeDecryptSettingValue(key: string | undefined, value: string): string {
  if (typeof key === "string" && !isSensitiveKey(key)) {
    return value;
  }
  // Cleared sensitive keys (e.g. apnsRelayKey, which is CLEARABLE) persist as
  // "" — the write side skips encryption for empty values, so there is nothing
  // to decrypt and running decryptToken would emit a bogus legacy-plaintext warn.
  // Clearing is also the recovery path for a corrupt row, so drop any recorded
  // decrypt failure here — otherwise the settings banner outlives the value.
  if (value === "") {
    if (typeof key === "string") settingDecryptFailures.delete(key);
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

// ─── Whole-column secrets: UserTotp.secret and NotificationAgent.secret ──────
// Every write of these `secret` columns is sensitive (unlike Setting, where
// sensitivity depends on the row's key), so the same value-level encryption is
// valid for bulk writes too — updateMany/createMany are ENCRYPTED rather than
// forbidden. Guardrail 7a forbids any caller from pre-encrypting. One shared
// implementation; the per-model wrappers below only name the model.
function encryptSecretColumnInPlace(data: Record<string, unknown> | undefined | null): void {
  if (!data) return;
  const v = data.secret;
  if (typeof v === "string" && v.length > 0) {
    data.secret = encryptToken(v);
  } else if (v && typeof v === "object" && typeof (v as { set?: unknown }).set === "string") {
    // Prisma's `{ set: "…" }` update form is the same write — never plaintext.
    const set = (v as { set: string }).set;
    if (set.length > 0) (v as { set: string }).set = encryptToken(set);
  }
}

// Fails CLOSED: an undecryptable secret becomes "" so the rest of the row can
// still be returned, and the log names the row and how to recover it.
function decryptSecretColumnInPlace(
  row: Record<string, unknown> | null | undefined,
  opts: { idField: string; model: string; scope: string; recovery: string },
): void {
  if (!row) return;
  const v = row.secret;
  if (typeof v !== "string" || v.length === 0) return;
  const idValue = row[opts.idField];
  const label = `${opts.model}.secret (${opts.idField}=${typeof idValue === "string" ? idValue : "?"})`;
  try {
    row.secret = decryptToken(v, label);
  } catch (err) {
    console.error(
      `[${opts.scope}] Decrypt failed for ${label} — ${opts.recovery}. Original error:`,
      err instanceof Error ? err.message : err,
    );
    row.secret = "";
  }
}

// UserTotp.secret (two-factor authenticator-app secret).
export function encryptTotpSecretInPlace(data: Record<string, unknown> | undefined | null): void {
  encryptSecretColumnInPlace(data);
}

export function decryptTotpSecretInPlace(row: Record<string, unknown> | null | undefined): void {
  // Wrong TOKEN_ENCRYPTION_KEY (e.g. a backup restored onto another server) or a
  // corrupt row. An empty secret verifies no code, so the user signs in with a
  // recovery code or a passkey, or an admin resets 2FA.
  decryptSecretColumnInPlace(row, {
    idField: "userId",
    model: "UserTotp",
    scope: "totp-crypto",
    recovery: "the user must use a recovery code or have an admin reset their two-factor",
  });
}

// NotificationAgent.secret (outbound channel credential).
export function encryptAgentSecretInPlace(data: Record<string, unknown> | undefined | null): void {
  encryptSecretColumnInPlace(data);
}

export function decryptAgentSecretInPlace(row: Record<string, unknown> | null | undefined): void {
  // Wrong TOKEN_ENCRYPTION_KEY (a backup restored onto another server) or a
  // corrupt row. Deliveries go out without the credential and the destination
  // rejects them, which the agent's lastError surfaces.
  decryptSecretColumnInPlace(row, {
    idField: "id",
    model: "NotificationAgent",
    scope: "agent-crypto",
    recovery: "re-enter this channel's secret in Settings → Notifications",
  });
}


// ─── the handlers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type QueryParams<A, R> = { args: A; query: (args: A) => PromiseLike<R> };
/** One query-extension handler: may rewrite `args` in place, then post-process the result. */
export type CryptoHandler = <A, R>(params: QueryParams<A, R>) => Promise<R>;

const asRow = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === "object") : []);
const argsOf = (args: unknown): Row => (asRow(args) ?? {});

/** How one column model is protected. */
export interface ColumnCrypto {
  model: string;
  /** Encrypts the protected column(s) of one write payload, in place. */
  encryptData(data: Row | null): void;
  /** Decrypts the protected column(s) of one returned row, in place; fails closed. */
  decryptRow(row: Row | null): void;
  /**
   * Many-row writes. "encrypt": every row of the column is a secret, so the
   * payload is encrypted like a single write. Otherwise the listed columns are
   * refused in a many-row payload, and the caller is sent to create/update/upsert.
   */
  bulk: { kind: "encrypt" } | { kind: "refuse"; fields: readonly string[] };
}

/** The operations every protected model intercepts (Setting adds deleteMany). */
export const COLUMN_CRYPTO_OPERATIONS = [
  "findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "findMany",
  "create", "update", "upsert", "delete",
  "createMany", "createManyAndReturn", "updateMany", "updateManyAndReturn",
] as const;
type ColumnOperation = (typeof COLUMN_CRYPTO_OPERATIONS)[number];

function bulkPayloads(data: unknown): Row[] {
  return Array.isArray(data) ? rowsOf(data) : asRow(data) ? [asRow(data)!] : [];
}

/**
 * The full handler set for one column model. The *OrThrow and *AndReturn
 * twins are separate Prisma operations, NOT aliases — each gets the same
 * treatment as its base, so none hands back ciphertext or writes plaintext.
 */
export function columnCryptoHandlers(c: ColumnCrypto): Record<ColumnOperation, CryptoHandler> {
  const readOne: CryptoHandler = async ({ args, query }) => {
    const row = await query(args);
    c.decryptRow(asRow(row));
    return row;
  };
  const readMany: CryptoHandler = async ({ args, query }) => {
    const rows = await query(args);
    for (const r of rowsOf(rows)) c.decryptRow(r);
    return rows;
  };
  const writeOne = (encrypt: (args: Row) => void): CryptoHandler => async ({ args, query }) => {
    encrypt(argsOf(args));
    const row = await query(args);
    c.decryptRow(asRow(row));
    return row;
  };
  // Encrypt or refuse a many-row payload, before any query runs.
  const prepareMany = (op: ColumnOperation, args: unknown): void => {
    const payloads = bulkPayloads(argsOf(args).data);
    if (c.bulk.kind === "encrypt") {
      for (const p of payloads) c.encryptData(p);
      return;
    }
    const fields = c.bulk.fields;
    if (payloads.some((p) => fields.some((f) => p[f] !== undefined))) {
      const alternative = op.startsWith("create") ? "create" : "update";
      throw new Error(
        `[prisma] ${c.model}.${op} with ${fields.join("/")} is forbidden — use ${c.model}.${alternative} or ${c.model}.upsert so the encryption extension runs`,
      );
    }
  };
  const writeMany = (op: ColumnOperation): CryptoHandler => async ({ args, query }) => {
    prepareMany(op, args);
    return query(args);
  };
  const writeManyAndReturn = (op: ColumnOperation): CryptoHandler => async ({ args, query }) => {
    prepareMany(op, args);
    const rows = await query(args);
    for (const r of rowsOf(rows)) c.decryptRow(r);
    return rows;
  };
  return {
    findUnique: readOne,
    findFirst: readOne,
    findUniqueOrThrow: readOne,
    findFirstOrThrow: readOne,
    findMany: readMany,
    create: writeOne((a) => c.encryptData(asRow(a.data))),
    update: writeOne((a) => c.encryptData(asRow(a.data))),
    upsert: writeOne((a) => {
      c.encryptData(asRow(a.create));
      c.encryptData(asRow(a.update));
    }),
    // A delete returns the deleted row: decrypt it like a read.
    delete: readOne,
    createMany: writeMany("createMany"),
    createManyAndReturn: writeManyAndReturn("createManyAndReturn"),
    updateMany: writeMany("updateMany"),
    updateManyAndReturn: writeManyAndReturn("updateManyAndReturn"),
  };
}

// ─── Setting ─────────────────────────────────────────────────────────────────

function decryptSettingRow(row: Row | null, key: string | undefined): void {
  if (row && typeof row.value === "string") {
    row.value = safeDecryptSettingValue(typeof row.key === "string" ? row.key : key, row.value);
  }
}

// `{ set: "…" }` is the same write as a plain string: normalise it so the
// encrypt below sees it. Any other operator on `value` is refused.
function normaliseSettingValueWrite(data: Row | null, op: string): void {
  if (!data || data.value === null || typeof data.value !== "object") return;
  const set = (data.value as { set?: unknown }).set;
  if (typeof set !== "string") {
    throw new Error(`[prisma] setting.${op} with a non-string \`value\` operation is forbidden`);
  }
  data.value = set;
}

function encryptSettingValue(data: Row | null, key: string): void {
  if (data && typeof data.value === "string" && data.value.length > 0 && isSensitiveKey(key)) {
    data.value = encryptToken(data.value);
  }
}

// updateMany sets the same `data` on every matching row, so we can't know each
// row's `key` to decide whether it is sensitive. Forbid writes that touch
// `value` and funnel callers to setting.update / setting.upsert where the
// extension runs.
function refuseSettingBulkValue(args: unknown, op: string): void {
  const data = asRow(argsOf(args).data);
  if (data && data.value !== undefined) {
    throw new Error(
      `[prisma] setting.${op} with \`value\` is forbidden — use setting.update or setting.upsert so the encryption extension runs`,
    );
  }
}

// Release decrypt-failure entries only AFTER the delete resolved, so a failed
// delete leaves the banner in place (same after-the-write ordering as
// guardrail 27). An unfiltered deleteMany removes every row, so nothing
// recorded can still exist.
function releaseDeletedSettingFailures(where: unknown): void {
  const keys = settingKeysFromDeleteWhere(where);
  if (keys === null) {
    if (where === undefined) settingDecryptFailures.clear();
  } else {
    for (const k of keys) settingDecryptFailures.delete(k);
  }
}

const settingRead: CryptoHandler = async ({ args, query }) => {
  const row = await query(args);
  decryptSettingRow(asRow(row), settingKeyFromArgs(args));
  return row;
};
const settingReadMany: CryptoHandler = async ({ args, query }) => {
  const rows = await query(args);
  for (const r of rowsOf(rows)) decryptSettingRow(r, undefined);
  return rows;
};

export const settingCryptoHandlers: Record<ColumnOperation | "deleteMany", CryptoHandler> = {
  findUnique: settingRead,
  findFirst: settingRead,
  findUniqueOrThrow: settingRead,
  findFirstOrThrow: settingRead,
  findMany: settingReadMany,
  async create({ args, query }) {
    // args.data may be a single object or (rare) Prisma's tuple shape — only the object form is supported.
    const data = asRow(argsOf(args).data);
    const key = typeof data?.key === "string" ? data.key : undefined;
    if (key !== undefined) encryptSettingValue(data, key);
    const row = await query(args);
    decryptSettingRow(asRow(row), key);
    return row;
  },
  async update({ args, query }) {
    const a = argsOf(args);
    const data = asRow(a.data);
    // Skip when the update doesn't touch `value` at all (e.g. metadata-only updates).
    normaliseSettingValueWrite(data, "update");
    if (data && typeof data.value === "string" && data.value.length > 0) {
      const key = asRow(a.where)?.key;
      // `key` is Setting's only unique field, so a unique `where` always
      // names it. Without it the sensitivity of the row is unknown, and a
      // guess could store a secret in plaintext — refuse instead.
      if (typeof key !== "string") {
        throw new Error("[prisma] setting.update without a string `where.key` is forbidden — name the row by its key so the encryption extension runs");
      }
      encryptSettingValue(data, key);
    }
    const row = await query(args);
    decryptSettingRow(asRow(row), settingKeyFromArgs(args));
    return row;
  },
  async upsert({ args, query }) {
    const a = argsOf(args);
    // An upsert's `where` is unique too, so it names the key.
    const key = asRow(a.where)?.key;
    if (typeof key === "string" && isSensitiveKey(key)) {
      encryptSettingValue(asRow(a.create), key);
      normaliseSettingValueWrite(asRow(a.update), "upsert");
      encryptSettingValue(asRow(a.update), key);
    }
    const row = await query(args);
    decryptSettingRow(asRow(row), settingKeyFromArgs(args));
    return row;
  },
  async delete({ args, query }) {
    const row = await query(args);
    decryptSettingRow(asRow(row), settingKeyFromArgs(args));
    releaseDeletedSettingFailures(argsOf(args).where);
    return row;
  },
  async createMany({ args, query }) {
    encryptSettingRowsInPlace(argsOf(args).data);
    return query(args);
  },
  async createManyAndReturn({ args, query }) {
    encryptSettingRowsInPlace(argsOf(args).data);
    const rows = await query(args);
    for (const r of rowsOf(rows)) decryptSettingRow(r, undefined);
    return rows;
  },
  async updateMany({ args, query }) {
    refuseSettingBulkValue(args, "updateMany");
    return query(args);
  },
  async updateManyAndReturn({ args, query }) {
    // Same per-row-key blindness as updateMany; the returned rows still need
    // decrypting for the non-`value` update case.
    refuseSettingBulkValue(args, "updateManyAndReturn");
    const rows = await query(args);
    for (const r of rowsOf(rows)) decryptSettingRow(r, undefined);
    return rows;
  },
  async deleteMany({ args, query }) {
    const result = await query(args);
    releaseDeletedSettingFailures(argsOf(args).where);
    return result;
  },
};

// ─── the extension's query block ─────────────────────────────────────────────
//
// Only TOP-LEVEL operations on these models are intercepted. A nested relation
// write or read — a nested create of a user's accounts, or an include/select
// of a user's accounts or totp relation — bypasses every handler; the
// reachability scans in tests/prisma-crypto-extension.test.mts and
// tests/mfa-prisma-extension.test.mts fail on one.
export const cryptoQueryExtension = {
  setting: settingCryptoHandlers,
  account: columnCryptoHandlers({
    model: "account",
    encryptData: encryptAccountTokensInPlace,
    decryptRow: decryptAccountTokensInPlace,
    bulk: { kind: "refuse", fields: ACCOUNT_TOKEN_FIELDS },
  }),
  userTotp: columnCryptoHandlers({
    model: "userTotp",
    encryptData: encryptTotpSecretInPlace,
    decryptRow: decryptTotpSecretInPlace,
    bulk: { kind: "encrypt" },
  }),
  notificationAgent: columnCryptoHandlers({
    model: "notificationAgent",
    encryptData: encryptAgentSecretInPlace,
    decryptRow: decryptAgentSecretInPlace,
    bulk: { kind: "encrypt" },
  }),
};

// Shared streaming-import pipeline for the encrypted full-DB backup.
//
// Both the admin restore (/api/admin/backup/db-import) and the first-run
// setup-mode restore (/api/setup/import) call processBackupImport. The
// security-sensitive bits — magic-header check, decryption, data-driven
// allowlist of SQL patterns (derived from BACKUP_TABLES/BACKUP_ENUMS),
// schema-fingerprint guard, atomic TRUNCATE+INSERT transaction —
// live here so they can't drift between the two callers.

import { promises as fsp, createReadStream } from "node:fs";
import path from "node:path";
import { restoreScratchDir } from "@/lib/restore-scratch";
import { prisma, type PrismaTxClient } from "@/lib/prisma";
import {
  hasEncryptedMagic,
  wrapDecryptStream,
  BackupCryptoError,
  ENCRYPTED_MAGIC,
} from "@/lib/backup-crypto";
import {
  BACKUP_TABLES,
  BACKUP_ENUMS,
  computeNormalizedSchemaFingerprint,
  computeSchemaFingerprint,
} from "@/lib/backup-schema";
import { tokenEncryptionKeyFingerprint } from "@/lib/token-crypto";
import { invalidateCachedSessionChecks } from "@/lib/session-revocation";
import { clearArrSnapshots } from "@/lib/arr-snapshot";
import { lockSetupInTx } from "@/lib/setup-lock";

// Verbose INSERT-per-row encoding inflates row data 3–5×. The validated
// statements are spooled to a temp file (never held in memory), so this cap
// bounds only disk space and restore time. Default 4 GB; a very large server
// can raise it with BACKUP_MAX_RESTORE_MB (the dump is also staged on disk by
// the chunked upload, so the temp directory needs roughly this much free
// space twice over).
const DEFAULT_MAX_RESTORE_MB = 4096;
function configuredMaxRestoreBytes(): number {
  const raw = Number(process.env.BACKUP_MAX_RESTORE_MB);
  const mb = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_RESTORE_MB;
  return mb * 1024 * 1024;
}
export const MAX_PLAINTEXT_BYTES = configuredMaxRestoreBytes();
export const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 4096;
// 10 minutes minimum, then one second per MB of plaintext, so a multi-GB
// restore isn't rolled back by a timeout sized for 500 MB. Every statement is
// its own round trip inside the one transaction, so a dump of many small rows
// (PlayHistory, AuditLog: thousands per MB) also gets time per statement.
const MIN_RESTORE_TX_TIMEOUT_MS = 10 * 60 * 1000;
const RESTORE_MS_PER_MB = 1000;
const RESTORE_MS_PER_STATEMENT = 2;
export function restoreTxTimeoutMs(plaintextBytes: number, statements: number): number {
  return Math.max(
    MIN_RESTORE_TX_TIMEOUT_MS,
    Math.ceil(plaintextBytes / (1024 * 1024)) * RESTORE_MS_PER_MB,
    statements * RESTORE_MS_PER_STATEMENT,
  );
}

// Validated statements, length-prefixed (uint32 BE + UTF-8) in a temp file so a
// restore's memory use does not grow with the dump. The directory is removed by
// dispose() on every exit path of processBackupImport.
class StatementSpool {
  count = 0;
  private dir: string | null = null;
  private file: string | null = null;
  private fh: fsp.FileHandle | null = null;
  private parts: Buffer[] = [];
  private pendingBytes = 0;

  add(stmt: string): void {
    const body = Buffer.from(stmt, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.parts.push(head, body);
    this.pendingBytes += 4 + body.length;
    this.count++;
  }

  needsFlush(): boolean {
    return this.pendingBytes >= 1024 * 1024;
  }

  async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    if (!this.fh) {
      this.dir = await fsp.mkdtemp(path.join(await restoreScratchDir(), "summonarr-restore-"));
      this.file = path.join(this.dir, "statements.bin");
      this.fh = await fsp.open(this.file, "w", 0o600);
    }
    const buf = Buffer.concat(this.parts);
    this.parts = [];
    this.pendingBytes = 0;
    await this.fh.write(buf);
  }

  async *read(): AsyncGenerator<string> {
    await this.flush();
    if (this.fh) {
      await this.fh.close();
      this.fh = null;
    }
    if (!this.file) return;
    // Read chunks are collected and joined only once enough bytes have arrived
    // for the next whole statement (`need`). Joining on every 64 KB read copied
    // a multi-MB statement once per read, quadratic in its size.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let need = 4;
    for await (const chunk of createReadStream(this.file)) {
      pending.push(chunk as Buffer);
      pendingBytes += (chunk as Buffer).length;
      if (pendingBytes < need) continue;
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      let off = 0;
      while (buf.length - off >= 4) {
        const len = buf.readUInt32BE(off);
        if (buf.length - off - 4 < len) break;
        yield buf.toString("utf8", off + 4, off + 4 + len);
        off += 4 + len;
      }
      const rest = buf.subarray(off);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
      need = rest.length >= 4 ? 4 + rest.readUInt32BE(0) : 4;
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.fh?.close();
    } catch {
      // already closed
    }
    this.fh = null;
    if (this.dir) {
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.dir = null;
    }
  }
}

// Build the allowlist from the single source of truth (BACKUP_TABLES / BACKUP_ENUMS).
// This prevents a future table/enum addition in the exporter from accidentally
// being allowed (or a removed one from still being accepted) by a stale regex.
const tableAlt = BACKUP_TABLES.map((t) => `"${t.replace(/"/g, '""')}"`).join("|");
const enumAlt = BACKUP_ENUMS.map((e) => e.replace(/'/g, "''")).join("|");

const ALLOWED_PATTERNS = [
  // Group 1 = column list, group 2 = VALUES tuple + optional ON CONFLICT tail.
  // Both are captured (rather than re-located with a second, weaker `indexOf`
  // scan) so the validator can never inspect a different clause than the one
  // Postgres will execute: `indexOf(") VALUES (")` is blind to double quotes,
  // so a column identifier containing that byte sequence made the validator
  // check a decoy tuple. The column-list group is LAZY on purpose — greedy
  // would resolve to the LAST `) VALUES (`, which for a legitimate dump can sit
  // inside row data (a Setting value containing the text `) VALUES (`) and
  // would then reject a valid backup.
  new RegExp(
    `^INSERT INTO "public"\\.(?:${tableAlt}) \\(([\\s\\S]*?)\\) VALUES (\\([\\s\\S]*\\)(?:\\s+ON CONFLICT(?:\\s*\\([^)]*\\))?\\s+DO NOTHING)?)$`,
  ),
  // The enum-label list used to be `\([^)]+\)` — "anything but `)`", which
  // admits newlines, `;`, `--` and `'`, i.e. arbitrary text smuggled into a
  // block that is executed verbatim as plpgsql. Pin it to exactly what
  // db-export emits: single-quoted labels (with `''` escapes) joined by `, `.
  new RegExp(
    `^DO \\$\\$ BEGIN IF NOT EXISTS \\(\\s*SELECT 1 FROM pg_type WHERE typname = '(?:${enumAlt})'\\) THEN CREATE TYPE "(?:${enumAlt})" AS ENUM \\('(?:[^']|'')*'(?:, ?'(?:[^']|'')*')*\\); END IF; END \\$\\$$`,
  ),
];

// The INSERT column list is the one region ALLOWED_PATTERNS[0] leaves free-form,
// and it is a grammatical expression position in Postgres (`ColId opt_indirection`
// admits `[ a_expr ]` subscripts), so it must be validated like the VALUES tuple
// is. db-export already refuses any column name outside /^[A-Za-z0-9_]{1,63}$/ and
// joins them with ", " — require exactly that shape. As a side effect the split
// above becomes unambiguous: a list of quoted identifiers contains no parens and
// no unbalanced quote, so the `)` the regex stopped at is the same one Postgres's
// lexer ends the column list on.
const COLUMN_LIST_RE = /^"[A-Za-z0-9_]{1,63}"(?:, ?"[A-Za-z0-9_]{1,63}")*$/;

interface SplitterState {
  current: string;
  lineComment: string;
  inSingleQuote: boolean;
  inDollarQuote: boolean;
  inLineComment: boolean;
  pendingDollar: boolean;
  pendingDash: boolean;
}

function newSplitterState(): SplitterState {
  return {
    current: "",
    lineComment: "",
    inSingleQuote: false,
    inDollarQuote: false,
    inLineComment: false,
    pendingDollar: false,
    pendingDash: false,
  };
}

// The characters that end a run of ordinary statement text outside any quote.
const STATEMENT_SPECIAL_RE = /['$;-]/g;

function nextStatementSpecial(chunk: string, from: number): number {
  STATEMENT_SPECIAL_RE.lastIndex = from;
  const m = STATEMENT_SPECIAL_RE.exec(chunk);
  return m ? m.index : chunk.length;
}

function endLineComment(state: SplitterState, onComment: (comment: string) => void): void {
  state.inLineComment = false;
  const c = state.lineComment.trim();
  if (c) onComment(c);
  state.lineComment = "";
}

// SQL splitter that:
//   • Splits statements on `;` (skipping `;` inside '...' or $$...$$).
//   • Routes `-- ... \n` line comments to onComment instead of gluing them
//     onto the next statement (which used to make the first INSERT after every
//     `-- Table: ...` comment fail validation and be dropped).
//   • A `$` or `-` at the very end of a chunk is held as "pending" until the
//     next chunk shows whether it starts `$$` or `--`.
// Text between the characters that matter is appended as one slice, never a
// character at a time: a restore feeds gigabytes through here.
function feedSqlChunk(
  state: SplitterState,
  chunk: string,
  onStatement: (stmt: string) => void,
  onComment: (comment: string) => void,
): void {
  let i = 0;
  while (i < chunk.length) {
    if (state.inLineComment) {
      const nl = chunk.indexOf("\n", i);
      if (nl === -1) {
        state.lineComment += chunk.slice(i);
        return;
      }
      state.lineComment += chunk.slice(i, nl);
      endLineComment(state, onComment);
      i = nl + 1;
      continue;
    }

    const ch = chunk[i];
    // A pending `$`/`-` is only ever set by a chunk's last character, so it
    // is resolved here by the first character of the next chunk.
    if (state.pendingDollar) {
      state.pendingDollar = false;
      if (ch === "$") {
        if (!state.inSingleQuote) state.inDollarQuote = !state.inDollarQuote;
        state.current += "$$";
        i++;
        continue;
      }
      state.current += "$";
    }
    if (state.pendingDash) {
      state.pendingDash = false;
      if (ch === "-" && !state.inSingleQuote && !state.inDollarQuote) {
        state.inLineComment = true;
        state.lineComment = "";
        i++;
        continue;
      }
      state.current += "-";
    }

    if (state.inSingleQuote) {
      const q = chunk.indexOf("'", i);
      if (q === -1) {
        state.current += chunk.slice(i);
        return;
      }
      state.current += chunk.slice(i, q + 1);
      if (chunk[q + 1] === "'") {
        state.current += "'";
        i = q + 2;
      } else {
        state.inSingleQuote = false;
        i = q + 1;
      }
      continue;
    }

    if (state.inDollarQuote) {
      const d = chunk.indexOf("$", i);
      if (d === -1) {
        state.current += chunk.slice(i);
        return;
      }
      state.current += chunk.slice(i, d);
      if (chunk[d + 1] === "$") {
        state.current += "$$";
        state.inDollarQuote = false;
        i = d + 2;
      } else {
        if (d === chunk.length - 1) state.pendingDollar = true;
        else state.current += "$";
        i = d + 1;
      }
      continue;
    }

    const s = nextStatementSpecial(chunk, i);
    if (s > i) {
      state.current += chunk.slice(i, s);
      i = s;
      continue;
    }
    i = handleStatementSpecial(state, chunk, i, onStatement);
  }
}

// One of `'`, `$`, `-` or `;` outside any quote; returns the next index.
function handleStatementSpecial(
  state: SplitterState,
  chunk: string,
  i: number,
  onStatement: (stmt: string) => void,
): number {
  const ch = chunk[i];
  const last = i === chunk.length - 1;
  if (ch === "'") {
    state.inSingleQuote = true;
    state.current += ch;
    return i + 1;
  }
  if (ch === "$") {
    if (chunk[i + 1] === "$") {
      state.inDollarQuote = true;
      state.current += "$$";
      return i + 2;
    }
    if (last) state.pendingDollar = true;
    else state.current += "$";
    return i + 1;
  }
  if (ch === "-") {
    if (chunk[i + 1] === "-") {
      state.inLineComment = true;
      state.lineComment = "";
      return i + 2;
    }
    if (last) state.pendingDash = true;
    else state.current += "-";
    return i + 1;
  }
  // ";"
  const trimmed = state.current.trim();
  if (trimmed) onStatement(trimmed);
  state.current = "";
  return i + 1;
}

function flushSqlChunk(
  state: SplitterState,
  onStatement: (stmt: string) => void,
  onComment: (comment: string) => void,
): void {
  if (state.pendingDollar) {
    state.current += "$";
    state.pendingDollar = false;
  }
  if (state.pendingDash) {
    state.current += "-";
    state.pendingDash = false;
  }
  if (state.inLineComment) endLineComment(state, onComment);
  const trimmed = state.current.trim();
  if (trimmed) onStatement(trimmed);
  state.current = "";
}

const SAFE_LITERAL_RE = /^(NULL|TRUE|FALSE|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|'(?:[^']|'')*')$/;

// What may legitimately follow the single VALUES tuple. The exporter emits
// exactly one `(...)` tuple optionally followed by `ON CONFLICT DO NOTHING`.
// Anything else — in particular a second `, (...)` tuple, which the greedy
// `VALUES \([\s\S]*\)` regex would otherwise admit — must be rejected.
// validateValuesTokens used to `return true` at the first tuple's closing `)`,
// so it never inspected a smuggled second tuple like `('a'), ((SELECT ...))`.
//
// The tail is matched WHOLE (anchored `$`), never by prefix. ALLOWED_PATTERNS[0]
// cannot be relied on to pin it: its `VALUES \([\s\S]*\)` is greedy, so the
// trailing `\)` happily matches the LAST `)` in the statement and the optional
// `ON CONFLICT … DO NOTHING` group then matches empty. That let a crafted dump
// smuggle `ON CONFLICT ("key") DO UPDATE SET "value" = (SELECT …)` past both the
// allowlist regex and this check — arbitrary SQL expression execution (sub-SELECT
// across any table, pg_read_file, …) as the app's DB role. The INSERT branch of
// isStatementSafe runs no keyword scan, so this is the only gate.
// `DO UPDATE` is never emitted by the exporter (db-export appends DO NOTHING).
const ON_CONFLICT_TAIL_RE = /^ON CONFLICT(?:\s*\([^()]*\))?\s+DO NOTHING$/i;

// Same shape, anchored to the END of a whole statement — used by the restore
// loop to decide whether a conflict clause is already present, so row data
// containing the words "ON CONFLICT" can't be mistaken for one.
const HAS_CONFLICT_TAIL_RE = /\)\s+ON CONFLICT(?:\s*\([^()]*\))?\s+DO NOTHING$/i;

function remainderAfterTupleIsSafe(rest: string): boolean {
  const trimmed = rest.trim();
  if (trimmed === "") return true;
  return ON_CONFLICT_TAIL_RE.test(trimmed);
}

function isTupleSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// One literal starting at `i`: a quoted string (with `''` escapes) runs to its
// closing quote, anything else to the next `,`, whitespace or `)`.
function readValueToken(clause: string, i: number): { token: string; next: number } {
  if (clause[i] === "'") {
    let j = i + 1;
    while (j < clause.length) {
      if (clause[j] === "'") {
        if (clause[j + 1] === "'") j += 2;
        else return { token: clause.slice(i, j + 1), next: j + 1 };
      } else {
        j++;
      }
    }
    return { token: clause.slice(i), next: clause.length };
  }
  let j = i;
  while (j < clause.length && !/[,\s)]/.test(clause[j])) j++;
  return { token: clause.slice(i, j), next: j };
}

// Exactly one `( literal, literal, … )` tuple, then only an allowed tail.
function validateValuesTokens(valuesClause: string): boolean {
  let i = 0;
  while (valuesClause[i] === " ") i++;
  if (valuesClause[i] !== "(") return false;
  i++;

  while (i < valuesClause.length) {
    while (isTupleSpace(valuesClause[i])) i++;
    if (i >= valuesClause.length) return false;
    if (valuesClause[i] === ")") return remainderAfterTupleIsSafe(valuesClause.slice(i + 1));

    const { token, next } = readValueToken(valuesClause, i);
    if (!SAFE_LITERAL_RE.test(token)) return false;
    i = next;

    while (isTupleSpace(valuesClause[i])) i++;
    if (i >= valuesClause.length) return false;
    const sep = valuesClause[i];
    if (sep === ",") { i++; continue; }
    if (sep === ")") return remainderAfterTupleIsSafe(valuesClause.slice(i + 1));
    return false;
  }
  return false;
}

function isStatementSafe(stmt: string): { ok: true } | { ok: false; reason: string } {
  const insertMatch = ALLOWED_PATTERNS[0].exec(stmt);
  if (insertMatch) {
    // INSERT — verify VALUES clause contains only literals so a malicious
    // dump can't smuggle a sub-SELECT or function call past the allowlist.
    // Extra safety check: pull out the table name and require it to be in
    // BACKUP_TABLES, in case the regex above is ever loosened by mistake.
    const tableMatch = /^INSERT INTO "public"\."([^"]+)"/i.exec(stmt);
    if (tableMatch && !BACKUP_TABLES.includes(tableMatch[1] as (typeof BACKUP_TABLES)[number])) {
      return { ok: false, reason: `Blocked INSERT for table not in BACKUP_TABLES: ${tableMatch[1]}` };
    }

    if (!COLUMN_LIST_RE.test(insertMatch[1])) {
      return { ok: false, reason: `Blocked INSERT with non-identifier column list: ${stmt.slice(0, 80)}...` };
    }
    // Both clauses come from the allowlist match itself, so validator and
    // executor agree on where the VALUES tuple starts.
    if (!validateValuesTokens(insertMatch[2])) {
      return { ok: false, reason: `Blocked INSERT with non-literal VALUES: ${stmt.slice(0, 80)}...` };
    }
    return { ok: true };
  }
  if (ALLOWED_PATTERNS[1].test(stmt)) {
    // DO $$ enum-create — the allowlist regex already pins the entire
    // statement shape (literal text, single typname, enum-label list), so
    // a keyword-blacklist would only false-positive on the literal
    // `SELECT 1 FROM pg_type` inside the block.
    return { ok: true };
  }
  // The allowlist is the whole policy: anything matching neither pattern is
  // refused. A future pattern gets its own branch above with its own checks.
  return { ok: false, reason: `Blocked disallowed statement: ${stmt.slice(0, 80)}...` };
}

export type BackupImportSummary = {
  total: number;
  executed: number;
  skipped: number;
  errors: number;
  // Rows the INSERT...ON CONFLICT DO NOTHING path silently dropped, grouped
  // by table. Empty object on a clean restore (TRUNCATE-then-INSERT means
  // every row should land); non-empty signals dump corruption — duplicate
  // PKs, conflicting rows, or schema drift the importer didn't catch.
  conflictSkippedByTable: Record<string, number>;
  conflictSkippedTotal: number;
};

export type BackupImportResult =
  | { ok: true; status: 200; summary: BackupImportSummary; warning: string | null }
  | { ok: false; status: number; error: string; errors?: string[]; summary?: BackupImportSummary };

export type BackupImportMode = "setup" | "admin";

type BackupFailure = Extract<BackupImportResult, { ok: false }>;

// The pre-auth ("setup") restore runs before any admin account exists and
// authenticates solely with BACKUP_DB_PASSWORD, so on an internet-facing
// instance a leaked/weak password lets an attacker replace the database before
// the legitimate operator registers. TRUST_PROXY=true marks the deployment as
// internet-facing; it then needs an explicit opt-in. A LAN/loopback deployment
// (the default) is already protected by the proxy's local-only Host guard, so
// its first-run restore keeps working with no extra configuration. The setup
// routes check the same predicate at chunk 0 (backup-routes.ts).
export function setupRestoreDisabled(): boolean {
  return process.env.TRUST_PROXY === "true" && process.env.SUMMONARR_ALLOW_SETUP_RESTORE !== "true";
}

// The messages a client can see for these fixed failures. backup-messages.ts
// translates them by this exact text.
export const SETUP_NOT_FRESH_MESSAGE = "Setup import is only available on a fresh server with no users.";
export const RESTORE_ROLLED_BACK_MESSAGE =
  "Restore failed and was rolled back — the database is unchanged. Check the server logs for details.";
export const SETUP_RESTORE_DISABLED_MESSAGE =
  "Pre-authentication restore is disabled on this internet-facing instance. " +
  "Set SUMMONARR_ALLOW_SETUP_RESTORE=true to enable a first-run restore, then unset it once the admin account exists.";
const READ_FAILED_MESSAGE = "Failed to read backup";

// Drops every other process memo built from the tables a restore replaces.
// After the commit only (guardrail 27), and best-effort: a failure here must not
// turn a committed restore into an error. Loaded on demand so the restore
// pipeline doesn't pull auth, play history and the rest into every module that
// imports it (import-session.ts does, for the size cap).
async function invalidateRestoredCaches(): Promise<void> {
  try {
    const { invalidateCachesAfterRestore } = await import("@/lib/restore-caches");
    invalidateCachesAfterRestore();
  } catch (err) {
    console.error("[backup/import] cache invalidation after restore failed:", err);
  }
}

// Raised by the replay stream when the upload passes MAX_CIPHERTEXT_BYTES.
class CiphertextOverflowError extends Error {}

function ciphertextOverflow(): BackupFailure {
  return { ok: false, status: 413, error: `Encrypted body exceeds ${MAX_CIPHERTEXT_BYTES} bytes` };
}

// A failure while reading or decrypting the upload, as a client result.
function readFailure(err: unknown, where: "drain" | "stream"): BackupFailure {
  if (err instanceof BackupCryptoError) return { ok: false, status: err.status, error: err.message };
  if (err instanceof CiphertextOverflowError) return ciphertextOverflow();
  console.error(`[backup] db-import ${where} error:`, err);
  return { ok: false, status: 400, error: READ_FAILED_MESSAGE };
}

// The first-run freshness test, read under advisory lock 43 (the caller takes
// it first, lockSetupInTx). Shared by the setup routes' gate (backup-routes.ts)
// and the restore transaction below, so the two can never disagree on "fresh".
export async function setupClosedInTx(
  tx: Pick<PrismaTxClient, "setting" | "user">,
): Promise<boolean> {
  const setupCompleted = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
  const userCount = await tx.user.count();
  return setupCompleted !== null || userCount > 0;
}

export async function processBackupImport(
  body: ReadableStream<Uint8Array>,
  password: string,
  mode: BackupImportMode = "admin",
): Promise<BackupImportResult> {
  const spool = new StatementSpool();
  try {
    return await runBackupImport(body, password, mode, spool);
  } finally {
    await spool.dispose();
  }
}

// Reads until the magic bytes are in hand (or the upload ends).
async function readHead(
  sourceReader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ head: Buffer } | BackupFailure> {
  let head = Buffer.alloc(0);
  try {
    while (head.length < ENCRYPTED_MAGIC.length) {
      const { value, done } = await sourceReader.read();
      if (done) break;
      if (value && value.byteLength > 0) head = Buffer.concat([head, Buffer.from(value)]);
    }
  } catch (err) {
    // A client that aborted the upload mid-header, for one.
    sourceReader.cancel().catch(() => {});
    return readFailure(err, "stream");
  }
  if (!hasEncryptedMagic(head)) {
    sourceReader.cancel().catch(() => {});
    return { ok: false, status: 400, error: "Backup file is not an encrypted Summonarr dump." };
  }
  if (head.length > MAX_CIPHERTEXT_BYTES) {
    sourceReader.cancel().catch(() => {});
    return ciphertextOverflow();
  }
  return { head };
}

// The whole upload again (the bytes readHead took first), refused with
// CiphertextOverflowError once it passes MAX_CIPHERTEXT_BYTES.
function replayUpload(head: Buffer, sourceReader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let firstEmitted = false;
  let totalCiphertextBytes = head.length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstEmitted) {
        firstEmitted = true;
        if (head.length > 0) controller.enqueue(new Uint8Array(head));
        return;
      }
      const { value, done } = await sourceReader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        totalCiphertextBytes += value.byteLength;
        if (totalCiphertextBytes > MAX_CIPHERTEXT_BYTES) {
          controller.error(new CiphertextOverflowError());
          sourceReader.cancel().catch(() => {});
          return;
        }
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      sourceReader.cancel(reason).catch(() => {});
    },
  });
}

const FINGERPRINT_RE = /^Schema-Fingerprint:\s*([0-9a-f]{8,64})$/i;
const NORMALIZED_FINGERPRINT_RE = /^Schema-Fingerprint-Normalized:\s*([0-9a-f]{8,64})$/i;
const TEK_FINGERPRINT_RE = /^Token-Encryption-Key-Fingerprint:\s*([0-9a-f]{8,64})$/i;
const MAX_VALIDATION_ERRORS = 20;

// What reading the whole plaintext produced: the validated statements are in
// the spool, everything else is here.
type ParsedDump = {
  totalStatements: number;
  totalPlaintextBytes: number;
  errors: string[];
  fingerprint: string | null;
  normalizedFingerprint: string | null;
  tekFingerprint: string | null;
};

// Decodes, splits and validates the plaintext into the spool. On an early stop
// (validation errors hit the cap, the size cap fires, the text is not UTF-8)
// the rest of the stream is still drained: wrapDecryptStream verifies the GCM
// auth tag only when its source ends, and bailing out before then would leave
// the tag unverified, a partial-tampering oracle. A tag failure outranks every
// other verdict, because a tampered ciphertext must read as a crypto failure,
// not a blocked statement.
async function parseDump(
  plaintextStream: ReadableStream<Uint8Array>,
  spool: StatementSpool,
): Promise<ParsedDump | BackupFailure> {
  // Fatal: a backup is UTF-8 by construction, so an invalid byte is
  // corruption, never text to restore as U+FFFD.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const splitter = newSplitterState();
  const parsed: ParsedDump = {
    totalStatements: 0,
    totalPlaintextBytes: 0,
    errors: [],
    fingerprint: null,
    normalizedFingerprint: null,
    tekFingerprint: null,
  };
  let abortReason: { error: string; status: number } | null = null;
  const aborted = () => abortReason !== null || parsed.errors.length >= MAX_VALIDATION_ERRORS;

  const onStatement = (stmt: string): void => {
    if (aborted()) return;
    parsed.totalStatements++;
    const safe = isStatementSafe(stmt);
    if (safe.ok) spool.add(stmt);
    else parsed.errors.push(safe.reason);
  };
  const onComment = (comment: string): void => {
    const m = FINGERPRINT_RE.exec(comment);
    if (m) parsed.fingerprint = m[1].toLowerCase();
    const nm = NORMALIZED_FINGERPRINT_RE.exec(comment);
    if (nm) parsed.normalizedFingerprint = nm[1].toLowerCase();
    const tm = TEK_FINGERPRINT_RE.exec(comment);
    if (tm) parsed.tekFingerprint = tm[1].toLowerCase();
  };
  // Decoding errors are corruption: stop like any other early abort.
  const feed = (decode: () => string): void => {
    let text: string;
    try {
      text = decode();
    } catch {
      abortReason = { error: READ_FAILED_MESSAGE, status: 400 };
      return;
    }
    feedSqlChunk(splitter, text, onStatement, onComment);
  };

  const ptReader = plaintextStream.getReader();
  try {
    while (!aborted()) {
      const { value, done } = await ptReader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      parsed.totalPlaintextBytes += value.byteLength;
      if (parsed.totalPlaintextBytes > MAX_PLAINTEXT_BYTES) {
        abortReason = { error: `SQL body exceeds ${MAX_PLAINTEXT_BYTES / (1024 * 1024)}MB limit`, status: 413 };
        break;
      }
      feed(() => decoder.decode(value, { stream: true }));
      if (spool.needsFlush()) await spool.flush();
    }
    if (!aborted()) {
      // Whatever the decoder still holds (a sequence cut at the end) must
      // decode too; a dangling partial sequence is corruption.
      feed(() => decoder.decode());
    }
    if (!aborted()) {
      flushSqlChunk(splitter, onStatement, onComment);
      await spool.flush();
    } else {
      try {
        while (!(await ptReader.read()).done) {
          // drained bytes are discarded
        }
      } catch (err) {
        return readFailure(err, "drain");
      }
    }
  } catch (err) {
    return readFailure(err, "stream");
  } finally {
    ptReader.releaseLock();
  }

  if (abortReason) return { ok: false, status: abortReason.status, error: abortReason.error };
  return parsed;
}

// The schema and key checks between a valid dump and the restore: a refusal,
// or the warnings to carry into the answer.
function fingerprintVerdict(parsed: ParsedDump): BackupFailure | { warnings: string[] } {
  const warnings: string[] = [];
  // The normalized fingerprint (newer exports) ignores comment and whitespace
  // edits; an older export carries only the byte fingerprint.
  const [received, expected] = parsed.normalizedFingerprint
    ? [parsed.normalizedFingerprint, computeNormalizedSchemaFingerprint()]
    : [parsed.fingerprint, parsed.fingerprint ? computeSchemaFingerprint() : null];
  if (received && received !== expected) {
    return {
      ok: false,
      status: 409,
      error:
        `Schema mismatch — restore refused. Backup fingerprint ${received} does not match this server's schema fingerprint ${expected}. The database has not been touched. Restore only into a server running the same schema version.`,
    };
  }
  if (!received) {
    warnings.push(
      `This backup has no schema fingerprint (it was created by an older version). Proceeding, but if the schema has drifted the restore will roll back partway through.`,
    );
  }
  // Encrypted secrets (API keys, OAuth tokens, SMTP password) are AES-encrypted with
  // TOKEN_ENCRYPTION_KEY. Restoring onto a server with a DIFFERENT key leaves them as
  // undecryptable ciphertext. Warn (don't refuse — the rest of the data restores fine
  // and the operator can re-enter the secrets afterward).
  const currentTekFingerprint = tokenEncryptionKeyFingerprint();
  if (parsed.tekFingerprint && currentTekFingerprint && parsed.tekFingerprint !== currentTekFingerprint) {
    warnings.push(
      `This backup's encrypted secrets (API keys, tokens, SMTP password, two-factor authenticator secrets) were encrypted with a different TOKEN_ENCRYPTION_KEY than this server uses — they will restore but won't be decryptable. Re-enter them in Settings after the restore.`,
    );
  }
  return { warnings };
}

const TRUNCATE_STMT = `TRUNCATE TABLE ${BACKUP_TABLES.map((t) => `"public"."${t}"`).join(", ")} RESTART IDENTITY`;

// INSERT INTO "public"."<Table>" (...) ...  — capture the table name to attribute
// conflict-skipped rows in the response summary. Statements are already validated
// against the BACKUP_TABLES allowlist (ALLOWED_PATTERNS above), so a plain
// capturing match suffices here. The group MUST be capturing: m[1] is the table name.
const INSERT_TABLE_RE = /^INSERT INTO "public"\."([^"]+)"/i;

// Older exports (pre-snapshot fix) could emit duplicate rows when a sync wrote
// between paginated SELECTs. Force-append ON CONFLICT DO NOTHING so the restore
// tolerates those dumps instead of aborting on the first collision. The
// TRUNCATE guarantees the only duplicates possible are within the dump itself.
// The "already has a conflict clause" test must be anchored at the end of the
// statement: an unanchored /ON CONFLICT/i also matches that text inside row
// data (an issue message quoting a Postgres error, a cached TMDB overview),
// which silently skipped the append for exactly the rows it protects — the
// duplicate then raised 23505 and rolled the whole restore back. Validation
// already pins the tail to this shape.
function withConflictTail(stmt: string): string {
  return stmt.startsWith("INSERT") && !HAS_CONFLICT_TAIL_RE.test(stmt) ? `${stmt} ON CONFLICT DO NOTHING` : stmt;
}

type RestoreCounts = { executed: number; conflictSkippedByTable: Record<string, number>; conflictSkippedTotal: number };

// TRUNCATE + replay + session wipe in ONE transaction: a refusal (setup mode
// found the server no longer fresh) or a thrown statement leaves the database
// as it was.
async function restoreInTransaction(
  spool: StatementSpool,
  mode: BackupImportMode,
  plaintextBytes: number,
): Promise<{ rejected: { status: number; error: string } } | RestoreCounts> {
  const counts: RestoreCounts = { executed: 0, conflictSkippedByTable: {}, conflictSkippedTotal: 0 };
  const rejection = await prisma.$transaction(async (tx) => {
    // Advisory lock 43 (setup-lock.ts) is shared with /api/auth/register and the setup
    // gates. Holding it inside the TRUNCATE+INSERT transaction guarantees a racing register
    // can't sneak a new user row between an outer freshness check and the truncate. In
    // "setup" mode we also re-check the freshness invariant under the lock so an attacker
    // can't pre-stage a chunked import and fire the final chunk after a legitimate admin
    // completes setup.
    await lockSetupInTx(tx);
    if (mode === "setup" && (await setupClosedInTx(tx))) {
      return { status: 409, error: SETUP_NOT_FRESH_MESSAGE };
    }
    await tx.$executeRawUnsafe(TRUNCATE_STMT);
    for await (const stmt of spool.read()) {
      const affected = await tx.$executeRawUnsafe(withConflictTail(stmt));
      counts.executed++;
      const m = INSERT_TABLE_RE.exec(stmt);
      if (m && typeof affected === "number" && affected === 0) {
        const table = m[1];
        counts.conflictSkippedByTable[table] = (counts.conflictSkippedByTable[table] ?? 0) + 1;
        counts.conflictSkippedTotal++;
      }
    }
    // A restore must not bring back sessions (guardrail 6g). The dump carries
    // the AuthSession rows AND each user's sessionsRevokedAt/passwordChangedAt
    // as of when it was taken, so restoring an older backup resurrected every
    // device the owner had signed out since — a stolen phone revoked last
    // week, or every session a password change ended. Native tokens never
    // expire (guardrail 6c), so that resurrection was permanent. Inside the
    // same transaction, so a rolled-back restore leaves sessions untouched.
    await tx.authSession.deleteMany({});
    await tx.user.updateMany({ data: { sessionsRevokedAt: new Date() } });
    return null;
  }, { timeout: restoreTxTimeoutMs(plaintextBytes, spool.count), maxWait: 10_000 });
  return rejection ? { rejected: rejection } : counts;
}

// The process memos a committed restore made stale. After the commit only
// (guardrail 27).
async function afterCommittedRestore(): Promise<void> {
  // The transaction committed: sessions are gone and every cutoff is now.
  // A cookie whose dbCheckedAt is still inside its window would otherwise
  // skip that lookup for up to 60s and act with its pre-restore privileges.
  invalidateCachedSessionChecks();
  // The Setting table was replaced, Radarr/Sonarr instances included: a
  // `cached=1` read skips its route's instance checks, so a kept answer could
  // paint an instance the restored config no longer has (guardrail 5h).
  clearArrSnapshots();
  // Every other memo built from the replaced tables (feature flags, the
  // Discord key, session lengths, agents, library and activity caches).
  await invalidateRestoredCaches();
}

// The splitter only ever emits non-empty statements, so nothing is skipped;
// the field stays in the summary (the routes, the UI and audit rows report it).
const SKIPPED_STATEMENTS = 0;

async function runBackupImport(
  body: ReadableStream<Uint8Array>,
  password: string,
  mode: BackupImportMode,
  spool: StatementSpool,
): Promise<BackupImportResult> {
  // The authoritative check of the setup routes' internet-facing opt-in.
  if (mode === "setup" && setupRestoreDisabled()) {
    body.cancel().catch(() => {});
    return { ok: false, status: 403, error: SETUP_RESTORE_DISABLED_MESSAGE };
  }

  const sourceReader = body.getReader();
  const headRead = await readHead(sourceReader);
  if ("ok" in headRead) return headRead;
  const replay = replayUpload(headRead.head, sourceReader);

  let plaintextStream: ReadableStream<Uint8Array>;
  try {
    plaintextStream = wrapDecryptStream(replay, password);
  } catch (err) {
    // wrapDecryptStream refuses an empty password synchronously, before it
    // takes the replay stream, so release the upload here.
    replay.cancel(err).catch(() => {});
    if (err instanceof BackupCryptoError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }

  const parsed = await parseDump(plaintextStream, spool);
  if ("ok" in parsed) return parsed;

  if (parsed.errors.length > 0) {
    return {
      ok: false,
      status: 200,
      error: "Backup failed validation",
      errors: parsed.errors,
      summary: {
        total: parsed.totalStatements,
        executed: 0,
        skipped: SKIPPED_STATEMENTS,
        errors: parsed.errors.length,
        conflictSkippedByTable: {},
        conflictSkippedTotal: 0,
      },
    };
  }

  let verdict: ReturnType<typeof fingerprintVerdict>;
  try {
    verdict = fingerprintVerdict(parsed);
  } catch (err) {
    // The schema file could not be read: nothing has been touched.
    console.error("[backup/import] schema fingerprint unavailable:", err);
    return { ok: false, status: 500, error: RESTORE_ROLLED_BACK_MESSAGE };
  }
  if ("ok" in verdict) return verdict;
  const { warnings } = verdict;

  // Defense-in-depth floor: a dump that decrypted cleanly (valid GCM tag) but
  // parsed to ZERO insertable statements would still TRUNCATE every table and
  // report ok — a "restore" of nothing is a silent wipe. No legitimate export
  // is empty (every instance has at least Setting rows), so refuse outright.
  if (spool.count === 0) {
    return {
      ok: false,
      status: 400,
      error: "Backup contains no data statements — refusing to wipe the database with an empty restore.",
    };
  }

  let restored: Awaited<ReturnType<typeof restoreInTransaction>>;
  try {
    restored = await restoreInTransaction(spool, mode, parsed.totalPlaintextBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log the underlying DB error server-side; do not echo it to the client.
    // The raw message can disclose schema/column/constraint internals.
    console.error("[backup/import] import failed:", msg);
    return { ok: false, status: 500, error: RESTORE_ROLLED_BACK_MESSAGE };
  }
  if ("rejected" in restored) {
    return { ok: false, status: restored.rejected.status, error: restored.rejected.error };
  }

  await afterCommittedRestore();

  warnings.push(
    "Every account was signed out by the restore (sessions in the backup are never brought back). Sign in again.",
  );
  if (restored.conflictSkippedTotal > 0) {
    warnings.push(
      `${restored.conflictSkippedTotal} duplicate row(s) in the backup were skipped on restore (the dump contained internal duplicates, e.g. from an older export). The restore is otherwise complete.`,
    );
  }

  return {
    ok: true,
    status: 200,
    summary: {
      total: parsed.totalStatements,
      executed: restored.executed,
      skipped: SKIPPED_STATEMENTS,
      errors: 0,
      conflictSkippedByTable: restored.conflictSkippedByTable,
      conflictSkippedTotal: restored.conflictSkippedTotal,
    },
    warning: warnings.length ? warnings.join(" ") : null,
  };
}

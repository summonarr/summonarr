// Shared streaming-import pipeline for the encrypted full-DB backup.
//
// Both the admin restore (/api/admin/backup/db-import) and the first-run
// setup-mode restore (/api/setup/import) call processBackupImport. The
// security-sensitive bits — magic-header check, decryption, allowlist of SQL
// patterns, schema-fingerprint guard, atomic TRUNCATE+INSERT transaction —
// live here so they can't drift between the two callers.

import { prisma } from "@/lib/prisma";
import {
  hasEncryptedMagic,
  wrapDecryptStream,
  BackupCryptoError,
  ENCRYPTED_MAGIC,
} from "@/lib/backup-crypto";
import { BACKUP_TABLES, computeSchemaFingerprint } from "@/lib/backup-schema";

// Verbose INSERT-per-row encoding inflates row data 3–5×; 500 MB plaintext
// covers a fully-loaded Summonarr instance with audit log + play history.
export const MAX_PLAINTEXT_BYTES = 500 * 1024 * 1024;
export const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 4096;
const RESTORE_TX_TIMEOUT_MS = 10 * 60 * 1000;

const ALLOWED_PATTERNS = [
  /^INSERT INTO "public"\."[A-Za-z]+" \([\s\S]*\) VALUES \([\s\S]*\)(?:\s+ON CONFLICT(?:\s*\([^)]*\))?\s+DO NOTHING)?$/,
  /^DO \$\$ BEGIN IF NOT EXISTS \(\s*SELECT 1 FROM pg_type WHERE typname = '[A-Za-z_]+'\) THEN CREATE TYPE "[A-Za-z_]+" AS ENUM \([^)]+\); END IF; END \$\$$/,
];

const DANGEROUS_SQL_PATTERN = /\b(SELECT|UPDATE|DELETE|DROP|ALTER|EXECUTE|COPY|CREATE\s+FUNCTION|SET\s+SESSION|SET\s+ROLE|GRANT|REVOKE|TRUNCATE|pg_read_file|pg_write_file|lo_import|lo_export|pg_execute_server_program|dblink|LOAD|pg_lo_import|pg_lo_export|current_setting|set_config)\b/i;

interface SplitterState {
  current: string;
  lineComment: string;
  inSingleQuote: boolean;
  inDollarQuote: boolean;
  inLineComment: boolean;
  pendingDollar: boolean;
  pendingDash: boolean;
}

// SQL splitter that:
//   • Splits statements on `;` (skipping `;` inside '...' or $$...$$).
//   • Routes `-- ... \n` line comments to onComment instead of accumulating
//     them into the next statement. The previous implementation conflated
//     comments with the following statement, which silently dropped the
//     first INSERT after every `-- Table: ...` summary comment in the dump.
function feedSqlChunk(
  state: SplitterState,
  chunk: string,
  onStatement: (stmt: string) => void,
  onComment: (comment: string) => void,
): void {
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];

    if (state.inLineComment) {
      if (ch === "\n") {
        state.inLineComment = false;
        const c = state.lineComment.trim();
        if (c) onComment(c);
        state.lineComment = "";
      } else {
        state.lineComment += ch;
      }
      continue;
    }

    if (state.pendingDollar) {
      state.pendingDollar = false;
      if (ch === "$") {
        if (!state.inSingleQuote) state.inDollarQuote = !state.inDollarQuote;
        state.current += "$$";
        continue;
      }
      state.current += "$";
    }

    if (state.pendingDash) {
      state.pendingDash = false;
      if (ch === "-" && !state.inSingleQuote && !state.inDollarQuote) {
        state.inLineComment = true;
        state.lineComment = "";
        continue;
      }
      state.current += "-";
    }

    if (state.inSingleQuote) {
      state.current += ch;
      if (ch === "'" && chunk[i + 1] === "'") {
        state.current += "'";
        i++;
      } else if (ch === "'") {
        state.inSingleQuote = false;
      }
      continue;
    }
    if (state.inDollarQuote) {
      if (ch === "$") {
        if (chunk[i + 1] === "$") {
          state.current += "$$";
          state.inDollarQuote = false;
          i++;
        } else if (i === chunk.length - 1) {
          state.pendingDollar = true;
        } else {
          state.current += "$";
        }
      } else {
        state.current += ch;
      }
      continue;
    }
    if (ch === "'") {
      state.inSingleQuote = true;
      state.current += ch;
      continue;
    }
    if (ch === "$") {
      if (chunk[i + 1] === "$") {
        state.inDollarQuote = true;
        state.current += "$$";
        i++;
      } else if (i === chunk.length - 1) {
        state.pendingDollar = true;
      } else {
        state.current += "$";
      }
      continue;
    }
    if (ch === "-") {
      if (chunk[i + 1] === "-") {
        state.inLineComment = true;
        state.lineComment = "";
        i++;
      } else if (i === chunk.length - 1) {
        state.pendingDash = true;
      } else {
        state.current += "-";
      }
      continue;
    }
    if (ch === ";") {
      const trimmed = state.current.trim();
      if (trimmed) onStatement(trimmed);
      state.current = "";
      continue;
    }
    state.current += ch;
  }
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
  if (state.inLineComment) {
    state.inLineComment = false;
    const c = state.lineComment.trim();
    if (c) onComment(c);
    state.lineComment = "";
  }
  const trimmed = state.current.trim();
  if (trimmed) onStatement(trimmed);
  state.current = "";
}

const SAFE_LITERAL_RE = /^(NULL|TRUE|FALSE|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|'(?:[^']|'')*')$/;

function validateValuesTokens(valuesClause: string): boolean {
  let i = 0;
  while (i < valuesClause.length && valuesClause[i] === " ") i++;
  if (valuesClause[i] !== "(") return false;
  i++;

  while (i < valuesClause.length) {
    while (i < valuesClause.length && /[ \t\n\r]/.test(valuesClause[i])) i++;
    if (i >= valuesClause.length) return false;
    if (valuesClause[i] === ")") return true;

    let token = "";
    if (valuesClause[i] === "'") {
      token += "'";
      i++;
      while (i < valuesClause.length) {
        const c = valuesClause[i++];
        token += c;
        if (c === "'") {
          if (valuesClause[i] === "'") { token += "'"; i++; }
          else break;
        }
      }
    } else {
      while (i < valuesClause.length && !/[,\s)]/.test(valuesClause[i])) {
        token += valuesClause[i++];
      }
    }

    if (!SAFE_LITERAL_RE.test(token)) return false;

    while (i < valuesClause.length && /[ \t\n\r]/.test(valuesClause[i])) i++;
    if (i >= valuesClause.length) return false;
    const sep = valuesClause[i];
    if (sep === ",") { i++; continue; }
    if (sep === ")") return true;
    return false;
  }
  return false;
}

function isStatementSafe(stmt: string): { ok: true } | { ok: false; reason: string } {
  if (ALLOWED_PATTERNS[0].test(stmt)) {
    // INSERT — verify VALUES clause contains only literals so a malicious
    // dump can't smuggle a sub-SELECT or function call past the allowlist.
    const valuesIdx = stmt.indexOf(") VALUES (");
    if (valuesIdx !== -1) {
      const valuesClause = stmt.slice(valuesIdx + 9);
      if (!validateValuesTokens(valuesClause)) {
        return { ok: false, reason: `Blocked INSERT with non-literal VALUES: ${stmt.slice(0, 80)}...` };
      }
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
  // Anything matching neither allowlist pattern. The DANGEROUS_SQL_PATTERN
  // check is defence-in-depth for any future allowlist entry; for the
  // existing two it's redundant.
  if (!ALLOWED_PATTERNS.some((p) => p.test(stmt))) {
    return { ok: false, reason: `Blocked disallowed statement: ${stmt.slice(0, 80)}...` };
  }
  const decommented = stmt
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
  if (DANGEROUS_SQL_PATTERN.test(decommented)) {
    return { ok: false, reason: `Blocked statement with suspicious keyword: ${stmt.slice(0, 80)}...` };
  }
  return { ok: true };
}

export type BackupImportSummary = { total: number; executed: number; skipped: number; errors: number };

export type BackupImportResult =
  | { ok: true; status: 200; summary: BackupImportSummary; warning: string | null }
  | { ok: false; status: number; error: string; errors?: string[]; summary?: BackupImportSummary };

export async function processBackupImport(
  body: ReadableStream<Uint8Array>,
  password: string,
): Promise<BackupImportResult> {
  const sourceReader = body.getReader();
  let head = Buffer.alloc(0);
  while (head.length < ENCRYPTED_MAGIC.length) {
    const { value, done } = await sourceReader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      head = Buffer.concat([head, Buffer.from(value)]);
    }
  }
  if (!hasEncryptedMagic(head)) {
    sourceReader.cancel().catch(() => {});
    return { ok: false, status: 400, error: "Backup file is not an encrypted Summonarr dump." };
  }

  let totalCiphertextBytes = head.length;
  const CIPHERTEXT_OVERFLOW_TAG = "__BACKUP_CIPHERTEXT_OVERFLOW__";
  if (totalCiphertextBytes > MAX_CIPHERTEXT_BYTES) {
    sourceReader.cancel().catch(() => {});
    return { ok: false, status: 413, error: `Encrypted body exceeds ${MAX_CIPHERTEXT_BYTES} bytes` };
  }

  let firstEmitted = false;
  const replay = new ReadableStream<Uint8Array>({
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
          controller.error(new Error(CIPHERTEXT_OVERFLOW_TAG));
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

  let plaintextStream: ReadableStream<Uint8Array>;
  try {
    plaintextStream = wrapDecryptStream(replay, password);
  } catch (err) {
    if (err instanceof BackupCryptoError) {
      return { ok: false, status: err.status, error: err.message };
    }
    throw err;
  }

  const decoder = new TextDecoder("utf-8");
  const splitter: SplitterState = {
    current: "",
    lineComment: "",
    inSingleQuote: false,
    inDollarQuote: false,
    inLineComment: false,
    pendingDollar: false,
    pendingDash: false,
  };
  let totalStatements = 0;
  let skipped = 0;
  const errors: string[] = [];
  let totalPlaintextBytes = 0;
  let aborted = false;
  let abortReason: { error: string; status: number } | null = null;
  const validatedStatements: string[] = [];
  let receivedFingerprint: string | null = null;

  const FINGERPRINT_RE = /^Schema-Fingerprint:\s*([0-9a-f]{8,64})$/i;

  function collectStatement(stmt: string): void {
    if (aborted) return;
    totalStatements++;
    if (!stmt) { skipped++; return; }
    const safe = isStatementSafe(stmt);
    if (!safe.ok) {
      errors.push(safe.reason);
      if (errors.length >= 20) aborted = true;
      return;
    }
    validatedStatements.push(stmt);
  }

  function collectComment(comment: string): void {
    const m = FINGERPRINT_RE.exec(comment);
    if (m) receivedFingerprint = m[1].toLowerCase();
  }

  const ptReader = plaintextStream.getReader();
  try {
    while (!aborted) {
      const { value, done } = await ptReader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalPlaintextBytes += value.byteLength;
      if (totalPlaintextBytes > MAX_PLAINTEXT_BYTES) {
        abortReason = { error: `SQL body exceeds ${MAX_PLAINTEXT_BYTES / (1024 * 1024)}MB limit`, status: 413 };
        aborted = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const pending: string[] = [];
      feedSqlChunk(splitter, text, (s) => pending.push(s), collectComment);
      for (const stmt of pending) {
        collectStatement(stmt);
        if (aborted) break;
      }
    }
    if (!aborted) {
      const pending: string[] = [];
      flushSqlChunk(splitter, (s) => pending.push(s), collectComment);
      for (const stmt of pending) collectStatement(stmt);
    }
  } catch (err) {
    if (err instanceof BackupCryptoError) {
      return { ok: false, status: err.status, error: err.message };
    }
    if (err instanceof Error && err.message === CIPHERTEXT_OVERFLOW_TAG) {
      return { ok: false, status: 413, error: `Encrypted body exceeds ${MAX_CIPHERTEXT_BYTES} bytes` };
    }
    console.error("[backup] db-import stream error:", err);
    return { ok: false, status: 400, error: "Failed to read backup" };
  } finally {
    ptReader.releaseLock();
  }

  if (abortReason) {
    return { ok: false, status: abortReason.status, error: abortReason.error };
  }

  if (errors.length > 0) {
    return {
      ok: false,
      status: 200,
      error: "Backup failed validation",
      errors,
      summary: { total: totalStatements, executed: 0, skipped, errors: errors.length },
    };
  }

  const expectedFingerprint = computeSchemaFingerprint();
  let fingerprintWarning: string | null = null;
  if (receivedFingerprint && receivedFingerprint !== expectedFingerprint) {
    return {
      ok: false,
      status: 409,
      error:
        `Schema mismatch — restore refused. Backup fingerprint ${receivedFingerprint} does not match this server's schema fingerprint ${expectedFingerprint}. The database has not been touched. Restore only into a server running the same schema version.`,
    };
  }
  if (!receivedFingerprint) {
    fingerprintWarning =
      `This backup has no schema fingerprint (it was created by an older version). Proceeding, but if the schema has drifted the restore will roll back partway through.`;
  }

  const truncateList = BACKUP_TABLES.map((t) => `"public"."${t}"`).join(", ");
  const truncateStmt = `TRUNCATE TABLE ${truncateList} RESTART IDENTITY`;

  let executed = 0;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(truncateStmt);
      for (const stmt of validatedStatements) {
        await tx.$executeRawUnsafe(stmt);
        executed++;
      }
    }, { timeout: RESTORE_TX_TIMEOUT_MS, maxWait: 10_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[backup/import] import failed:", msg);
    return {
      ok: false,
      status: 500,
      error: `Restore failed and was rolled back — database is unchanged. Database error: ${msg}`,
    };
  }

  return {
    ok: true,
    status: 200,
    summary: { total: totalStatements, executed, skipped, errors: 0 },
    warning: fingerprintWarning,
  };
}

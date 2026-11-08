// Behaviour checks for the at-rest crypto handlers (src/lib/prisma-crypto.ts,
// guardrail 7a), shared by the Setting/Account, UserTotp and NotificationAgent
// suites. Each handler is called directly with a fake `query`, so what it
// hands the query (encrypted?) and what it hands back (decrypted?) is
// observed, not read off the source. No database.
import assert from "node:assert/strict";
import { encryptToken } from "../src/lib/token-crypto.ts";
import type { CryptoHandler } from "../src/lib/prisma-crypto.ts";

export type Handlers = Record<string, CryptoHandler>;
type Row = Record<string, unknown>;

/** Runs one handler; returns what its query received and what the handler returned. */
export async function runHandler(
  handlers: Handlers,
  op: string,
  args: Row,
  answer: unknown,
): Promise<{ sent: Row | null; result: unknown }> {
  const h = handlers[op];
  assert.ok(h, `no ${op} handler`);
  let sent: Row | null = null;
  const result = await h({
    args,
    query: async (a: Row) => {
      sent = structuredClone(a);
      return structuredClone(answer);
    },
  });
  return { sent, result };
}

export const READ_ONE_OPS = ["findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow", "delete"];
export const MANY_RETURN_OPS = ["findMany", "createManyAndReturn", "updateManyAndReturn"];

/**
 * Every row-returning handler decrypts `column` in what it returns. `rowOf`
 * builds a stored row from a ciphertext.
 */
export async function assertReadsDecrypt(
  handlers: Handlers,
  column: string,
  rowOf: (cipher: string) => Row,
  argsFor: (op: string) => Row = () => ({ where: {} }),
): Promise<void> {
  const plain = "plain-secret-value";
  const cipher = encryptToken(plain);
  for (const op of READ_ONE_OPS) {
    const { result } = await runHandler(handlers, op, argsFor(op), rowOf(cipher));
    assert.equal((result as Row)[column], plain, `${op} hands back ciphertext`);
  }
  for (const op of MANY_RETURN_OPS) {
    const { result } = await runHandler(handlers, op, argsFor(op), [rowOf(cipher)]);
    assert.equal((result as Row[])[0][column], plain, `${op} hands back ciphertext`);
  }
}

/** A write payload's `column` reached the query as enc:v1 ciphertext, never the plaintext. */
export function assertEncrypted(value: unknown, what: string): void {
  const s = typeof value === "object" && value !== null ? (value as { set?: unknown }).set : value;
  assert.equal(typeof s, "string", `${what}: no value reached the query`);
  assert.match(s as string, /^enc:v1:/, `${what} reached the database in plaintext`);
}

/**
 * create/update/upsert encrypt every write branch BEFORE the query and hand
 * back the decrypted row; `payload(value)` is one write payload.
 */
export async function assertSingleWritesEncrypt(
  handlers: Handlers,
  column: string,
  payload: (value: unknown) => Row,
  where: Row,
): Promise<void> {
  const plain = "plain-secret-value";
  const stored = (sent: Row | null, branch: string) => (sent?.[branch] as Row | undefined)?.[column];
  for (const op of ["create", "update"]) {
    // `{ set }` is an update form only; a create takes the plain value.
    for (const value of op === "update" ? [plain, { set: plain }] : [plain]) {
      const args: Row = op === "create" ? { data: payload(value) } : { where, data: payload(value) };
      const { sent, result } = await runHandler(handlers, op, args, payload(encryptToken(plain)));
      assertEncrypted(stored(sent, "data"), `${op} (${typeof value})`);
      assert.equal((result as Row)[column], plain, `${op} hands back ciphertext`);
    }
  }
  const { sent, result } = await runHandler(
    handlers, "upsert", { where, create: payload(plain), update: payload(plain) }, payload(encryptToken(plain)),
  );
  assertEncrypted(stored(sent, "create"), "upsert's create branch");
  assertEncrypted(stored(sent, "update"), "upsert's update branch");
  assert.equal((result as Row)[column], plain, "upsert hands back ciphertext");
}

/** Many-row writes of a whole-column secret are encrypted, single object or array. */
export async function assertBulkWritesEncrypt(handlers: Handlers, column: string): Promise<void> {
  const plain = "plain-secret-value";
  for (const op of ["updateMany", "updateManyAndReturn"]) {
    const { sent } = await runHandler(handlers, op, { where: {}, data: { [column]: plain } }, op.endsWith("Return") ? [] : { count: 1 });
    assertEncrypted((sent?.data as Row)[column], op);
  }
  for (const op of ["createMany", "createManyAndReturn"]) {
    const { sent } = await runHandler(handlers, op, { data: [{ [column]: plain }, { [column]: plain }] }, op.endsWith("Return") ? [] : { count: 2 });
    for (const row of sent?.data as Row[]) assertEncrypted(row[column], op);
  }
}

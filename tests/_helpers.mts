// Shared helpers for the node:test unit suite (not a test file — the runner
// glob is tests/*.test.mts).
//
// shadowPrismaModel encapsulates the established prisma-stubbing idiom
// (originating in tests/jellyfin-config.test.mts): assign an in-memory stub
// over a model delegate on the shared extended client — Prisma 7's $extends
// result exposes model delegates as own writable data properties — then VERIFY
// the assignment took effect and throw loudly if it didn't. Without the guard,
// a Prisma upgrade that makes delegates non-writable would leave the real
// delegate in place and the first query would hang against a DB that doesn't
// exist in this harness.
//
// NOTE: this helper shadows delegates on an ALREADY-CONSTRUCTED client. The
// other established pattern — pre-seeding `globalThis.prisma` with a whole
// fake client BEFORE the module graph loads (tests/poster-cache.test.mts,
// tests/cron-auth.test.mts) — is a different idiom and does not use this
// helper: there is no real client to shadow anything on.

function shadowPrismaProperty(
  prisma: object,
  prop: string,
  stub: unknown,
  stubLabel: string,
): void {
  (prisma as Record<string, unknown>)[prop] = stub;
  if ((prisma as Record<string, unknown>)[prop] !== stub) {
    throw new Error(
      `could not shadow prisma.${prop} with ${stubLabel} — aborting before a real DB query can hang`,
    );
  }
}

/**
 * Shadow a model delegate (prisma.setting, prisma.mediaRequest, …) with an
 * in-memory stub, aborting the file if the assignment doesn't take effect.
 * Call it at module scope, BEFORE any test runs. `stubLabel` customizes the
 * abort message (e.g. "the throwing stub"); defaults to "the in-memory stub".
 */
export function shadowPrismaModel(
  prisma: object,
  modelName: string,
  stub: unknown,
  stubLabel = "the in-memory stub",
): void {
  shadowPrismaProperty(prisma, modelName, stub, stubLabel);
}

/**
 * Variant of shadowPrismaModel for client-level methods ($queryRaw,
 * $executeRaw, $transaction, …). Identical mechanics — the separate name (and
 * the `$`-prefixed type) keeps call sites self-describing about shadowing the
 * client surface rather than a model delegate.
 */
export function shadowPrismaClientMethod(
  prisma: object,
  methodName: `$${string}`,
  fn: unknown,
  stubLabel = "the in-memory stub",
): void {
  shadowPrismaProperty(prisma, methodName, fn, stubLabel);
}

/**
 * Per-PROCESS state for lib modules, not per-module-instance.
 *
 * Turbopack inlines a lib module into every server chunk that imports it, so a
 * plain `const seen = new Set()` at module scope is scoped to the CHUNK, not the
 * process. Measured on a production build of this app: `src/lib/token-crypto.ts`
 * was compiled into 10 separate server chunks and `src/lib/prisma.ts` into 4, and
 * each copy carried its own Set. Anything that means "remember across the whole
 * server" therefore silently became "remember within whichever bundle ran".
 *
 * That is invisible until it is not: the token-crypto legacy-plaintext warning
 * calls itself warn-ONCE, but operators saw the same Setting key warn repeatedly
 * as different cron routes (living in different chunks) touched the row. The same
 * shape would let guardrail 7b's `warnOnChange` re-emit an unchanged condition
 * once per chunk, which is exactly the log flood it exists to prevent, and it
 * makes `getSettingDecryptFailures()` under-report to the admin banner because
 * the reader sees only its own chunk's failures.
 *
 * `globalThis` is the one binding every chunk shares. `src/lib/prisma.ts` already
 * relies on that for its client (see the note there about hot-reload creating new
 * module instances); this generalises it so the next module that needs
 * process-wide state does not have to rediscover the problem.
 *
 * NOT for state that must outlive the process or be shared between replicas —
 * that is what the database is for. This is only about making one process agree
 * with itself.
 */

const REGISTRY = Symbol.for("summonarr.processSingletons");

type Registry = Map<string, unknown>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = holder[REGISTRY];
  if (existing) return existing;
  const created: Registry = new Map();
  holder[REGISTRY] = created;
  return created;
}

/**
 * Return the one instance of `key` for this process, creating it on first use.
 *
 * `key` must be globally unique — namespace it by module (`"token-crypto:…"`),
 * because every chunk of every module shares this one registry. `create` runs at
 * most once per process; later callers get the same object back, so callers can
 * hold the returned reference at module scope exactly as they held the literal.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const reg = registry();
  if (!reg.has(key)) reg.set(key, create());
  return reg.get(key) as T;
}

/** Test seam: drop a singleton so a suite cannot leak state into the next. */
export function __resetProcessSingletonForTests(key: string): void {
  registry().delete(key);
}

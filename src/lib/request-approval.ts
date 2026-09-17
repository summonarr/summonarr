import { Prisma } from "@/generated/prisma";
import { BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

// MediaRequest.approvedAt records that a request was approved, and the request
// watch grade counts only approved requests (guardrail 34a). The status column
// can't answer that on its own: a library sync marks a PENDING request AVAILABLE
// when its title arrives, so AVAILABLE doesn't imply anyone approved it.
//
// This module is the one-time bridge for rows older than the column.

// Setting marker, written in the same transaction as the backfill.
export const REQUEST_APPROVAL_BACKFILL_KEY = "requestApprovedAtBackfillRanAt";

// A failed first run can't simply wait for the next boot. Until a run succeeds,
// a library sync can mark pending requests AVAILABLE with no approval, and the
// run that finally succeeds would stamp those rows as approved. So a failed run
// is retried here, before the server takes requests.
const BACKFILL_ATTEMPTS = 3;

// Stamps approvedAt with createdAt on every APPROVED or AVAILABLE request that
// has none, and records that it ran. RUNS ONCE EVER, not once per boot: after
// the first run, a null approvedAt on an AVAILABLE row means a library sync
// fulfilled it before anyone approved its title, and a second run would stamp
// exactly those rows.
//
// The rows it stamps count as approved because nothing recorded whether they
// were. An old AVAILABLE row may have come straight from PENDING, but no column
// and no surviving audit row can tell. createdAt stands in for the unknown
// approval time; only the value's presence is read.
//
// Returns how many rows were stamped (0 when it had already run).
export async function backfillRequestApprovals(opts: { retryDelayMs?: number } = {}): Promise<number> {
  const retryDelayMs = opts.retryDelayMs ?? 2_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await backfillOnce();
    } catch (err) {
      if (attempt >= BACKFILL_ATTEMPTS) throw err;
      console.warn(
        `[request-approval] backfill attempt ${attempt} of ${BACKFILL_ATTEMPTS} failed, retrying:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

// The UPDATE and the marker commit together, so a failed run leaves nothing
// behind. The marker insert is the transaction's last write and is never caught
// inside it (guardrail 23): if another process wrote the marker first, the throw
// rolls this run's UPDATE back.
//
// maxWait and timeout are well past Prisma's interactive defaults (2s to get a
// connection, 5s to finish). A run that times out on slow storage or a busy pool
// rolls back, and every older approved request stays out of the grade until a
// run succeeds.
async function backfillOnce(): Promise<number> {
  const ran = await prisma.setting.findUnique({ where: { key: REQUEST_APPROVAL_BACKFILL_KEY } });
  if (ran) return 0;
  try {
    return await prisma.$transaction(async (tx) => {
      const stamped = await tx.$executeRaw`
        UPDATE "MediaRequest"
        SET "approvedAt" = "createdAt"
        WHERE "approvedAt" IS NULL
          AND "status" IN ('APPROVED', 'AVAILABLE')
      `;
      await tx.setting.create({ data: { key: REQUEST_APPROVAL_BACKFILL_KEY, value: new Date().toISOString() } });
      return stamped;
    }, { maxWait: 10_000, timeout: BATCH_TX_TIMEOUT });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return 0;
    throw err;
  }
}

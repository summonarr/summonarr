import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { cryptoQueryExtension } from "@/lib/prisma-crypto";

// The at-rest crypto lives in prisma-crypto.ts; these are its public helpers.
export {
  getSettingDecryptFailures,
  settingKeysFromDeleteWhere,
  settingKeyFromArgs,
  encryptTotpSecretInPlace,
  decryptTotpSecretInPlace,
  encryptAgentSecretInPlace,
  decryptAgentSecretInPlace,
} from "@/lib/prisma-crypto";

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
// Unset until the first load stores it (below).
const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

// Small pool: this is a single-tenant app, and a low cap avoids exhausting
// Postgres connections. DATABASE_POOL_MAX raises it for a busy install (sync
// jobs and interactive transactions share this pool with web requests);
// anything that isn't a whole number from 1 to 100 keeps the default.
export const DEFAULT_DATABASE_POOL_MAX = 5;
export function databasePoolMax(raw: string | undefined): number {
  const n = raw !== undefined && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_DATABASE_POOL_MAX;
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: databasePoolMax(process.env.DATABASE_POOL_MAX),
  });

  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // Transparent at-rest crypto for Setting rows (keyed by `key`), Account rows
  // (specific OAuth-token columns), UserTotp.secret (the two-factor
  // authenticator secret) and NotificationAgent.secret — see prisma-crypto.ts.
  return base.$extends({
    name: "setting-and-account-crypto",
    query: cryptoQueryExtension,
  });
}

// ONE client, and so one pg pool, per process in every environment. Turbopack
// compiles this module into several server chunks (process-singleton.ts) and
// dev hot-reload creates new module instances; a client per copy would make the
// real connection ceiling DATABASE_POOL_MAX times the number of copies.
// globalThis is the one binding they all share. (The slot stays the plain
// `globalThis.prisma` rather than a processSingleton key: the unit suites seed
// it with a fake before this module loads.)
export const prisma = (globalForPrisma.prisma ??= createPrismaClient());

// The interactive-transaction client of the EXTENDED client: the generated
// Prisma.TransactionClient is not assignable to it (the encryption extension
// changes the client's type), so derive it from `prisma`.
export type PrismaTxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

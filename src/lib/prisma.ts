import { PrismaClient } from "@/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { decryptToken } from "@/lib/token-crypto";

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient };

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

  // Transparently decrypt Setting values on read so callers always see plaintext regardless of storage format
  return base.$extends({
    name: "setting-decryption",
    query: {
      setting: {
        async findUnique({ args, query }) {
          const row = await query(args);
          if (row && typeof row.value === "string") row.value = decryptToken(row.value);
          return row;
        },
        async findFirst({ args, query }) {
          const row = await query(args);
          if (row && typeof row.value === "string") row.value = decryptToken(row.value);
          return row;
        },
        async findMany({ args, query }) {
          const rows = await query(args);
          for (const r of rows) {
            if (typeof r.value === "string") r.value = decryptToken(r.value);
          }
          return rows;
        },
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// In dev, Next.js hot-reloads create new module instances; caching on globalThis prevents connection pool exhaustion
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

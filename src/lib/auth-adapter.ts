import type { PrismaClient } from "@/generated/prisma";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";

/**
 * Minimal Prisma adapter for Auth.js — vendored in place of `@auth/prisma-adapter`.
 *
 * Summonarr uses JWT sessions, and OIDC is the only true OAuth provider (Plex,
 * Jellyfin and local-credentials are Credentials providers that bypass the adapter
 * entirely). That leaves the user + account methods below as the whole live
 * surface. The upstream adapter's session, verification-token and authenticator
 * methods were dead code here and are intentionally omitted.
 *
 * Methods are returned untyped-then-asserted, mirroring the upstream package
 * (shipped as plain JS): the Prisma row types carry Summonarr's extra columns
 * (`role`, `plexUserId`, …) and are structurally wider than Auth.js's
 * `AdapterUser`/`AdapterAccount`, so the assertion is at the return boundary.
 */
export function prismaAuthAdapter(
  prisma: PrismaClient | ReturnType<PrismaClient["$extends"]>,
): Adapter {
  const p = prisma as PrismaClient;
  return {
    // Drop any incoming id so the schema's default (uuid) wins.
    createUser: ({ id: _id, ...data }) =>
      p.user.create({ data }) as unknown as Promise<AdapterUser>,
    getUser: (id) =>
      p.user.findUnique({ where: { id } }) as unknown as Promise<AdapterUser | null>,
    getUserByEmail: (email) =>
      p.user.findUnique({ where: { email } }) as unknown as Promise<AdapterUser | null>,
    async getUserByAccount(provider_providerAccountId) {
      const account = await p.account.findUnique({
        where: { provider_providerAccountId },
        include: { user: true },
      });
      return (account?.user ?? null) as AdapterUser | null;
    },
    updateUser: ({ id, ...data }) =>
      p.user.update({ where: { id }, data }) as unknown as Promise<AdapterUser>,
    linkAccount: (data) =>
      p.account.create({ data }) as unknown as Promise<AdapterAccount>,
    unlinkAccount: (provider_providerAccountId) =>
      p.account.delete({
        where: { provider_providerAccountId },
      }) as unknown as Promise<AdapterAccount>,
  };
}

import { prisma } from "@/lib/prisma";

/** The stored values of exactly these keys; a key with no row is absent. */
export type SettingsOf<K extends readonly string[]> = Partial<Record<K[number], string>>;

/**
 * One read of the Setting rows a tab renders. Only those keys: every tab used
 * to read (and decrypt) all ~150, secrets included, whatever it showed.
 * Sensitive values arrive decrypted from the Prisma extension and a tab only
 * ever reports whether one is set (guardrail 7a).
 */
export async function readSettings<const K extends readonly string[]>(keys: K): Promise<SettingsOf<K>> {
  if (keys.length === 0) return {};
  const rows = await prisma.setting.findMany({ where: { key: { in: [...keys] } } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as SettingsOf<K>;
}

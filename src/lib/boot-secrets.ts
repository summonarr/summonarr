// Boot-time check that the three server secrets are independent (guardrail 6g).
// Pure — no env reads, no logging — so instrumentation.ts wires it and
// tests/boot-secrets.test.mts pins every rule.
//
// Each secret guards something different, and reusing one value collapses them:
//   - NEXTAUTH_SECRET signs every session. Whoever knows it can forge any
//     session, ADMIN included, with no database row needed to look valid.
//   - CRON_SECRET is a bearer token that schedulers send over the wire and the
//     machine-session flow accepts. It is the most exposed of the three.
//   - TOKEN_ENCRYPTION_KEY decrypts every stored API key, token and two-factor
//     secret.
// So NEXTAUTH_SECRET == CRON_SECRET lets anyone holding the cron secret forge
// an admin session, and either one equal to TOKEN_ENCRYPTION_KEY lets its holder
// decrypt every stored credential. Length checks (elsewhere) can't see this.
export interface BootSecrets {
  nextAuthSecret?: string;
  cronSecret?: string;
  tokenEncryptionKey?: string;
}

export function secretReuseError(env: BootSecrets): string | null {
  const auth = env.nextAuthSecret?.trim() ?? "";
  const cron = env.cronSecret?.trim() ?? "";
  // The encryption key is hex; compare case-insensitively so "AB…" and "ab…"
  // (the same 32 bytes) are caught.
  const tek = env.tokenEncryptionKey?.trim().toLowerCase() ?? "";
  const same: string[] = [];
  if (auth && cron && auth === cron) same.push("NEXTAUTH_SECRET and CRON_SECRET");
  if (auth && tek && auth.toLowerCase() === tek) same.push("NEXTAUTH_SECRET and TOKEN_ENCRYPTION_KEY");
  if (cron && tek && cron.toLowerCase() === tek) same.push("CRON_SECRET and TOKEN_ENCRYPTION_KEY");
  if (same.length === 0) return null;
  return (
    `[startup] ${same.join("; ")} are set to the same value. Each must be its own random secret: ` +
    "reusing one lets whoever holds the cron secret forge sessions or decrypt stored credentials. " +
    "Generate separate values with: openssl rand -base64 32 (NEXTAUTH_SECRET, CRON_SECRET) and " +
    "openssl rand -hex 32 (TOKEN_ENCRYPTION_KEY). Changing NEXTAUTH_SECRET signs everyone out; " +
    "changing TOKEN_ENCRYPTION_KEY makes stored secrets unreadable (re-enter them in Settings)."
  );
}

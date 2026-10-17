// Boot-time check that the three server secrets are independent (guardrail 6g),
// plus the optional NEXTAUTH_SECRET_PREVIOUS rotation key (guardrail 6h).
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
  // NEXTAUTH_SECRET_PREVIOUS (guardrail 6h): verify-only during a rotation, but
  // still a key that accepts forged tokens, so it must not be any other secret.
  nextAuthSecretPrevious?: string;
  cronSecret?: string;
  tokenEncryptionKey?: string;
}

export function secretReuseError(env: BootSecrets): string | null {
  const auth = env.nextAuthSecret?.trim() ?? "";
  const cron = env.cronSecret?.trim() ?? "";
  // The encryption key is hex; compare case-insensitively so "AB…" and "ab…"
  // (the same 32 bytes) are caught.
  const tek = env.tokenEncryptionKey?.trim().toLowerCase() ?? "";
  const prev = env.nextAuthSecretPrevious?.trim() ?? "";
  const same: string[] = [];
  if (auth && cron && auth === cron) same.push("NEXTAUTH_SECRET and CRON_SECRET");
  if (prev && cron && prev === cron) same.push("NEXTAUTH_SECRET_PREVIOUS and CRON_SECRET");
  if (prev && tek && prev.toLowerCase() === tek) same.push("NEXTAUTH_SECRET_PREVIOUS and TOKEN_ENCRYPTION_KEY");
  if (auth && tek && auth.toLowerCase() === tek) same.push("NEXTAUTH_SECRET and TOKEN_ENCRYPTION_KEY");
  if (cron && tek && cron.toLowerCase() === tek) same.push("CRON_SECRET and TOKEN_ENCRYPTION_KEY");
  if (same.length === 0) return null;
  return (
    `[startup] ${same.join("; ")} are set to the same value. Each must be its own random secret: ` +
    "reusing one lets whoever holds the cron secret forge sessions or decrypt stored credentials. " +
    "Generate separate values with: openssl rand -base64 32 (NEXTAUTH_SECRET, CRON_SECRET) and " +
    "openssl rand -hex 32 (TOKEN_ENCRYPTION_KEY). Changing NEXTAUTH_SECRET signs everyone out unless " +
    "the old value is kept as NEXTAUTH_SECRET_PREVIOUS; " +
    "changing TOKEN_ENCRYPTION_KEY makes stored secrets unreadable (re-enter them in Settings)."
  );
}

// NEXTAUTH_SECRET_PREVIOUS sanity (guardrail 6h). Unset is the normal case. It
// held a NEXTAUTH_SECRET once, so it must meet the same 32-character floor —
// shorter means it was never a real secret, and accepting forgeries under it
// would be worse than the sign-out it is meant to avoid (fatal). The same value
// as NEXTAUTH_SECRET is harmless but does nothing (signing-keys.ts ignores it),
// which usually means the rotation was only half done (warning).
export function previousSecretProblem(env: BootSecrets): { fatal: boolean; message: string } | null {
  const prev = env.nextAuthSecretPrevious;
  if (prev === undefined || prev.trim().length === 0) return null;
  if (prev.trim().length < 32) {
    return {
      fatal: true,
      message:
        "[startup] NEXTAUTH_SECRET_PREVIOUS is set but shorter than 32 characters. It must be the exact " +
        "value NEXTAUTH_SECRET had before the rotation; unset it to sign out the sessions that value signed.",
    };
  }
  if (prev === env.nextAuthSecret) {
    return {
      fatal: false,
      message:
        "[startup] NEXTAUTH_SECRET_PREVIOUS equals NEXTAUTH_SECRET, so it is ignored. To rotate, set " +
        "NEXTAUTH_SECRET to a new value and keep the old one as NEXTAUTH_SECRET_PREVIOUS.",
    };
  }
  return null;
}

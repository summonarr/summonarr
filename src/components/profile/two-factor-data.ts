// How Profile → Two-factor (two-factor.tsx) reads the /api/profile/mfa*
// answers. Pure and React-free so the unit suite runs it directly
// (tests/two-factor-ui.test.mts). A malformed entry never reaches a render or
// a key: it is dropped (a passkey row) or refused (the whole answer).
import { check, v } from "@/lib/validate";
import type { CreationOptionsJSON } from "@/lib/client/webauthn";

export interface TwoFactorPasskey {
  id: string;
  name: string;
  createdAt: string; // ISO — formatted only after mount (guardrail 16)
  lastUsedAt: string | null;
  backedUp: boolean;
}

export interface TwoFactorState {
  enabled: boolean;
  totpEnabled: boolean;
  passkeys: TwoFactorPasskey[];
  recoveryCodesRemaining: number;
  webauthnAvailable: boolean;
}

const Passkey = v.object({
  id: v.string(),
  name: v.string(),
  createdAt: v.string(),
  lastUsedAt: v.nullable(v.string()),
  backedUp: v.boolean(),
});

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** GET /api/profile/mfa as the section's state; a passkey row that isn't one is left out. */
export function readTwoFactorState(data: unknown): TwoFactorState {
  const d = record(data);
  const passkeys: TwoFactorPasskey[] = [];
  if (Array.isArray(d.passkeys)) {
    for (const p of d.passkeys) {
      const r = check(Passkey, p);
      if (r.ok) passkeys.push(r.value);
    }
  }
  const remaining = Number(d.recoveryCodesRemaining ?? 0);
  return {
    enabled: !!d.enabled,
    totpEnabled: !!d.totpEnabled,
    passkeys,
    recoveryCodesRemaining: Number.isFinite(remaining) ? remaining : 0,
    webauthnAvailable: !!d.webauthnAvailable,
  };
}

const RecoveryCodes = v.array(v.string());

/** The answer's new recovery codes, or null when it carries no list of strings. */
export function readRecoveryCodes(data: unknown): string[] | null {
  const r = check(RecoveryCodes, record(data).recoveryCodes);
  return r.ok ? r.value : null;
}

// The fields createPasskey reads unconditionally. The rest are optional and
// passed through as the server sent them.
const CreationShape = v.object({
  rp: v.object({ id: v.string(), name: v.string() }),
  user: v.object({ id: v.string(), name: v.string(), displayName: v.string() }),
  challenge: v.string(),
  pubKeyCredParams: v.array(v.object({ type: v.literal("public-key"), alg: v.number() })),
});

/** The passkey options answer's `publicKey`, or null when it is not usable. */
export function readCreationOptions(data: unknown): CreationOptionsJSON | null {
  const publicKey = record(data).publicKey;
  return check(CreationShape, publicKey).ok ? (publicKey as CreationOptionsJSON) : null;
}

/** The TOTP setup answer's key and URI, or null when either is missing. */
export function readTotpSetup(data: unknown): { secret: string; otpauthUri: string } | null {
  const { secret, otpauthUri } = record(data);
  return typeof secret === "string" && typeof otpauthUri === "string" ? { secret, otpauthUri } : null;
}

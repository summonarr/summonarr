// The email a NEW local account may be created with — first-admin registration
// and the admin "Create user" form share this one rule. Pure.
import { normalizeEmail } from "@/lib/email-normalize";

export const MAX_ACCOUNT_EMAIL_LENGTH = 254;

const WHITESPACE = /\s/;

// The normalized address, or null when it is not one a person can sign in
// with. Normalize FIRST, then validate the normalized value: NFKC folds a
// fullwidth "＠" (neither whitespace nor "@") into a real "@", so validating
// the raw string let `a＠b@c.com` pass the single-@ rule and be stored as
// `a@b@c.com`. Whitespace is still refused on the RAW value (padding is
// rejected, never trimmed, so two addresses differing only by padding can't
// both be accepted). The domain needs a dot that is neither its first nor its
// last character. Reserved domains are the caller's check (reserved-email.ts):
// the two routes answer them with their own message.
export function parseAccountEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ACCOUNT_EMAIL_LENGTH || WHITESPACE.test(raw)) {
    return null;
  }
  const normalized = normalizeEmail(raw);
  if (!normalized || normalized.length > MAX_ACCOUNT_EMAIL_LENGTH || WHITESPACE.test(normalized)) return null;
  const parts = normalized.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const domainDot = parts[1].lastIndexOf(".");
  if (domainDot < 1 || domainDot === parts[1].length - 1) return null;
  return normalized;
}

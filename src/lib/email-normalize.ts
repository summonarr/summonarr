// Canonicalizes an email for storage, lookup, and comparison: NFKC + lowercase
// + trim. The NFKC pass folds compatibility/homoglyph variants to one canonical
// form so two visually-identical-but-codepoint-distinct addresses can't mint
// separate accounts or sidestep an email-keyed lookup. Lives in this tiny module
// so non-auth callers can import it without pulling in the heavy auth + Prisma
// import graph.
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").toLowerCase().trim();
}

// RFC-5322-lite: local@domain, at least one dot in the domain, no whitespace.
// Intentionally loose — SMTP rejects anything this lets through. One pattern
// for the notification-address routes and the profile form, which must agree.
export const PLAUSIBLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

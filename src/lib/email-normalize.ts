// Canonicalizes an email for storage, lookup, and comparison: NFKC + lowercase
// + trim. The NFKC pass folds compatibility/homoglyph variants to one canonical
// form so two visually-identical-but-codepoint-distinct addresses can't mint
// separate accounts or sidestep an email-keyed lookup. Lives in this tiny module
// so non-auth callers can import it without pulling in the heavy auth + Prisma
// import graph.
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").toLowerCase().trim();
}

// The password length rules, shared by every route that sets a password
// (register, admin create, password change) and every form that asks for one.
// Zero imports, so client components can use it: password-hash.ts pulls in
// node:crypto. scripts/reset-password.mjs and create-user.mjs are standalone
// and keep their own copy of the minimum (guardrail 6g).

// The floor every new password must meet.
export const MIN_PASSWORD_LENGTH = 12;

// Shared upper bound for user-supplied passwords. Enforced identically on every
// write (register, password change) AND on credential sign-in, so a password that
// is accepted can always authenticate — a write cap above the sign-in cap would
// silently lock out anyone whose password landed in the gap. scrypt has no length
// limit of its own; this just bounds the work an unauthenticated caller can demand.
export const MAX_PASSWORD_LENGTH = 1024;

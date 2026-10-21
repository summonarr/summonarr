// Who may sign in through OIDC (guardrail 34e). Pure, zero-import: the rules,
// the stored shape and its validation. The loader and the sign-in orchestration
// that apply it live in oidc-signin.ts.
//
// Off by default — an empty policy admits everyone the IdP authenticates, which
// is the behaviour before this existed. Each part narrows independently:
//   - groups: the configured claim (default "groups") must name at least one
//     listed group. Exact, case-sensitive match: some IdPs treat "Admins" and
//     "admins" as different groups.
//   - emailDomains: the IdP-VERIFIED email must be in a listed domain (exact
//     domain, no subdomains). An unverified address is the user's own claim,
//     and on a multi-tenant IdP anyone can claim any domain.
//   - existingUsersOnly: never mint a new account (findOrCreateOidcUser's
//     `allowCreate: false`).
// The first two apply to EVERY sign-in, existing accounts included — taking
// someone out of the group refuses their next sign-in. Nothing here ends a
// session that already exists; deactivate the user for that (guardrail 33).

export const OIDC_ALLOWLIST_SETTING_KEY = "oidcAllowlist";

export interface OidcAllowlist {
  groups: string[];
  groupsClaim: string;
  // Ask the IdP for the "groups" scope too. Some IdPs (Authelia) release the
  // claim only when it is requested; others reject an unknown scope outright,
  // so it is opt-in.
  requestGroupsScope: boolean;
  emailDomains: string[];
  existingUsersOnly: boolean;
}

export const DEFAULT_OIDC_ALLOWLIST: OidcAllowlist = {
  groups: [],
  groupsClaim: "groups",
  requestGroupsScope: false,
  emailDomains: [],
  existingUsersOnly: false,
};

export const OIDC_ALLOWLIST_MAX_ENTRIES = 50;
const MAX_GROUP_LENGTH = 256;
// A JWT claim name: "groups", "roles", or a namespaced URI some IdPs use
// ("https://example.com/claims/groups").
const CLAIM_NAME_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type OidcAllowlistField = "groups" | "groupsClaim" | "requestGroupsScope" | "emailDomains" | "existingUsersOnly";

export type OidcAllowlistValidation =
  | { ok: true; value: OidcAllowlist }
  | { ok: false; field: OidcAllowlistField };

function normalizeDomain(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/^@/, "");
}

// Validates a whole policy (the PATCH body, or a stored value). A field that is
// wrong refuses the WHOLE policy — nothing is repaired or dropped, so what is
// saved is exactly what the admin typed. Lists are trimmed and de-duplicated;
// blank entries are dropped (a trailing newline in the text box).
export function validateOidcAllowlist(input: unknown): OidcAllowlistValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, field: "groups" };
  const body = input as Record<string, unknown>;

  const groups: string[] = [];
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups)) return { ok: false, field: "groups" };
    for (const g of body.groups) {
      if (typeof g !== "string") return { ok: false, field: "groups" };
      const trimmed = g.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_GROUP_LENGTH || CONTROL_RE.test(trimmed)) return { ok: false, field: "groups" };
      if (!groups.includes(trimmed)) groups.push(trimmed);
    }
    if (groups.length > OIDC_ALLOWLIST_MAX_ENTRIES) return { ok: false, field: "groups" };
  }

  let groupsClaim = DEFAULT_OIDC_ALLOWLIST.groupsClaim;
  if (body.groupsClaim !== undefined) {
    if (typeof body.groupsClaim !== "string") return { ok: false, field: "groupsClaim" };
    const trimmed = body.groupsClaim.trim();
    if (trimmed) {
      if (!CLAIM_NAME_RE.test(trimmed)) return { ok: false, field: "groupsClaim" };
      groupsClaim = trimmed;
    }
  }

  let requestGroupsScope = false;
  if (body.requestGroupsScope !== undefined) {
    if (typeof body.requestGroupsScope !== "boolean") return { ok: false, field: "requestGroupsScope" };
    requestGroupsScope = body.requestGroupsScope;
  }

  const emailDomains: string[] = [];
  if (body.emailDomains !== undefined) {
    if (!Array.isArray(body.emailDomains)) return { ok: false, field: "emailDomains" };
    for (const d of body.emailDomains) {
      if (typeof d !== "string") return { ok: false, field: "emailDomains" };
      const domain = normalizeDomain(d);
      if (!domain) continue;
      if (!DOMAIN_RE.test(domain)) return { ok: false, field: "emailDomains" };
      if (!emailDomains.includes(domain)) emailDomains.push(domain);
    }
    if (emailDomains.length > OIDC_ALLOWLIST_MAX_ENTRIES) return { ok: false, field: "emailDomains" };
  }

  let existingUsersOnly = false;
  if (body.existingUsersOnly !== undefined) {
    if (typeof body.existingUsersOnly !== "boolean") return { ok: false, field: "existingUsersOnly" };
    existingUsersOnly = body.existingUsersOnly;
  }

  return { ok: true, value: { groups, groupsClaim, requestGroupsScope, emailDomains, existingUsersOnly } };
}

// The stored Setting value → the policy. No row ⇒ the default (off). A row that
// does not parse or validate ⇒ null, which sign-in treats as REFUSE: a
// hand-edited or truncated value must not quietly turn the allowlist off.
export function parseOidcAllowlist(raw: string | null | undefined): OidcAllowlist | null {
  if (raw === null || raw === undefined) return { ...DEFAULT_OIDC_ALLOWLIST };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = validateOidcAllowlist(parsed);
  return result.ok ? result.value : null;
}

export function serializeOidcAllowlist(policy: OidcAllowlist): string {
  return JSON.stringify(policy);
}

// The settings form's text boxes ↔ the lists. Groups split on NEWLINES ONLY: a
// comma is legal inside a group name (an LDAP DN such as
// "cn=media,ou=groups,dc=corp", a display name such as "Plex, Friends"), and
// splitting there would store fragments that either match nothing or match an
// unrelated group. Domains also accept commas, which DOMAIN_RE never allows
// inside one.
export function parseGroupLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function parseDomainLines(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export function formatAllowlistLines(list: readonly string[]): string {
  return list.join("\n");
}

// The group names a claim carries: an array of strings (every common IdP), or a
// single string. Anything else, or an absent claim, is null. Own properties
// only, so a claim named "constructor" can't read the prototype.
export function readGroupsClaim(claims: Record<string, unknown>, name: string): string[] | null {
  if (!Object.hasOwn(claims, name)) return null;
  const value = claims[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((g): g is string => typeof g === "string");
  return null;
}

export type OidcAllowlistRefusal =
  | "not_in_allowed_group"
  | "email_unverified"
  | "email_missing"
  | "email_domain_not_allowed";

export interface OidcAllowlistSubject {
  email: string | null;
  emailVerified: boolean;
  // From the configured claim; null when the IdP sent none.
  groups: string[] | null;
}

// The groups and domain rules (existingUsersOnly is applied where an account
// would be created). Null ⇒ admitted.
export function evaluateOidcAllowlist(policy: OidcAllowlist, subject: OidcAllowlistSubject): OidcAllowlistRefusal | null {
  if (policy.groups.length > 0) {
    const held = subject.groups ?? [];
    if (!held.some((g) => policy.groups.includes(g))) return "not_in_allowed_group";
  }
  if (policy.emailDomains.length > 0) {
    if (!subject.email) return "email_missing";
    if (!subject.emailVerified) return "email_unverified";
    const at = subject.email.lastIndexOf("@");
    const domain = at === -1 ? "" : normalizeDomain(subject.email.slice(at + 1));
    if (!policy.emailDomains.includes(domain)) return "email_domain_not_allowed";
  }
  return null;
}

// True when any part of the policy restricts sign-in — what the settings card
// shows as "on".
export function isOidcAllowlistActive(policy: OidcAllowlist): boolean {
  return policy.groups.length > 0 || policy.emailDomains.length > 0 || policy.existingUsersOnly;
}

import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import {
  DEFAULT_OIDC_ALLOWLIST,
  OIDC_ALLOWLIST_MAX_ENTRIES,
  OIDC_ALLOWLIST_SETTING_KEY,
  parseOidcAllowlist,
  serializeOidcAllowlist,
  validateOidcAllowlist,
  type OidcAllowlistField,
} from "@/lib/oidc-allowlist";

// Who may sign in through OIDC (guardrail 34e) — ADMIN only: it decides who
// gets into the server at all, which is no delegate's call.
// GET: { allowlist, unreadable } — `unreadable: true` means the stored value
// doesn't parse and every OIDC sign-in is being refused; `allowlist` is then
// the default, for the form to start from.
// PATCH: the whole policy ({ groups, groupsClaim, requestGroupsScope,
// emailDomains, existingUsersOnly }); a wrong field refuses the whole body and
// nothing is repaired on write. Answers with the policy as saved.

// ~50 groups of 256 characters plus 50 domains fits in well under 32 KB.
const MAX_BODY_BYTES = 32 * 1024;

function fieldError(field: OidcAllowlistField, t: Translator): string {
  switch (field) {
    case "groups":
      return t("apiAdmin.oidcAllowlist.groups", { max: OIDC_ALLOWLIST_MAX_ENTRIES });
    case "groupsClaim":
      return t("apiAdmin.oidcAllowlist.groupsClaim");
    case "emailDomains":
      return t("apiAdmin.oidcAllowlist.emailDomains", { max: OIDC_ALLOWLIST_MAX_ENTRIES });
    case "requestGroupsScope":
    case "existingUsersOnly":
      return t("apiAdmin.oidcAllowlist.flag", { field });
  }
}

export const GET = withAdmin(async () => {
  const row = await prisma.setting.findUnique({ where: { key: OIDC_ALLOWLIST_SETTING_KEY } });
  const allowlist = parseOidcAllowlist(row?.value);
  return NextResponse.json({ allowlist: allowlist ?? DEFAULT_OIDC_ALLOWLIST, unreadable: allowlist === null });
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<unknown>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const result = validateOidcAllowlist(parsed);
  if (!result.ok) {
    return NextResponse.json({ error: fieldError(result.field, t) }, { status: 400 });
  }
  const value = serializeOidcAllowlist(result.value);
  await prisma.setting.upsert({
    where: { key: OIDC_ALLOWLIST_SETTING_KEY },
    create: { key: OIDC_ALLOWLIST_SETTING_KEY, value },
    update: { value },
  });
  // Committed with no enclosing transaction left ⇒ the swallowing variant (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "oidc-allowlist",
    details: { changed: { [OIDC_ALLOWLIST_SETTING_KEY]: result.value } },
    ...auditContext(req, session),
  });
  return NextResponse.json({ allowlist: result.value, unreadable: false });
});

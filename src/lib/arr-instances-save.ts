// The body of POST /api/admin/arr-instances, checked before anything is
// written, and what one posted instance writes to its connection Setting rows.
// Pure (no prisma): the route owns the transaction.
import {
  type ArrInstanceConfig,
  type ArrSettingField,
  isRadarrMinimumAvailability,
  isValidInstanceSlug,
} from "@/lib/arr-instances";
import type { Translator } from "@/lib/i18n/translate";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { validateServerUrl } from "@/lib/server-url";

// The display name renders on every "Request on <instance>" button, request-queue
// chip and admin badge; bounded like the notification-agent sibling.
export const INSTANCE_NAME_MAX_LEN = 100;
// An API key is 32 hex characters and a generated webhook secret 48; anything
// near this is a paste error, not a credential.
export const SECRET_MAX_LEN = 512;
// A root folder is a filesystem path on the arr's host.
export const ROOT_FOLDER_MAX_LEN = 1024;

export interface InstancePayload {
  slug: string;
  name?: string;
  restricted?: boolean;
  serverAll?: boolean;
  skipLibraryCheck?: boolean;
  autoRoute?: ArrInstanceConfig["autoRoute"];
  url?: string;
  // The browser-facing address ("Open in Radarr" links); null clears it.
  externalUrl?: string | null;
  apiKey?: string;
  rootFolder?: string;
  qualityProfileId?: number | string | null;
  webhookSecret?: string;
  // Radarr: announced | inCinemas | released; null clears (use Radarr's default).
  minimumAvailability?: string | null;
  // Sonarr v3: a language-profile id; null clears (don't send on adds).
  languageProfileId?: number | string | null;
}

// A profile id as the form sends it: a positive whole number, or those digits
// as text. Anything else (true, [5], "5.0", " 5") would be stored as text that
// reads back as no profile at all.
export function isProfileIdInput(v: unknown): boolean {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 1;
  return typeof v === "string" && /^\d{1,15}$/.test(v) && Number(v) >= 1;
}

// A field the save clears with null or "" and leaves alone when absent.
const isClear = (v: unknown) => v === null || v === "";

/**
 * The first thing wrong with one posted instance, worded as the 400's error,
 * or null when it can be saved. A refused body opens no transaction.
 */
export function instancePayloadError(raw: unknown, t: Translator): string | null {
  const inst = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<Record<keyof InstancePayload, unknown>>;
  const slug = inst.slug;
  if (typeof slug !== "string" || !isValidInstanceSlug(slug)) {
    return t("apiAdmin.common.invalidSlug", { slug: String(slug) });
  }
  // The secrets go to a String column as sent: anything but a string (a
  // number, null, an object) failed inside the transaction as a 500.
  for (const [field, value] of [["apiKey", inst.apiKey], ["webhookSecret", inst.webhookSecret]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > SECRET_MAX_LEN)) {
      return t("apiAdmin.common.invalidSecret", { slug, field, max: SECRET_MAX_LEN });
    }
  }
  // A root folder that is not text would be dropped by the save and read
  // as success.
  if (inst.rootFolder !== undefined && (typeof inst.rootFolder !== "string" || inst.rootFolder.length > ROOT_FOLDER_MAX_LEN)) {
    return t("apiAdmin.common.invalidSecret", { slug, field: "rootFolder", max: ROOT_FOLDER_MAX_LEN });
  }
  // Radarr's minimumAvailability is a closed enum — a bad stored value would
  // 400 every future add on the instance.
  const availability = inst.minimumAvailability;
  if (availability !== undefined && !isClear(availability)) {
    if (typeof availability !== "string" || !isRadarrMinimumAvailability(availability)) {
      return t("apiAdmin.arrInstances.invalidMinimumAvailability", { slug, value: String(availability) });
    }
  }
  // getCfg drops a non-numeric stored profile id on read, but the junk row
  // would still be echoed by GET and render as the blank "server default"
  // choice until re-saved.
  if (inst.languageProfileId !== undefined && !isClear(inst.languageProfileId) && !isProfileIdInput(inst.languageProfileId)) {
    return t("apiAdmin.arrInstances.invalidLanguageProfileId", { slug });
  }
  if (inst.qualityProfileId !== undefined && !isClear(inst.qualityProfileId) && !isProfileIdInput(inst.qualityProfileId)) {
    return t("apiAdmin.arrInstances.invalidQualityProfileId", { slug });
  }
  // Same URL rules as the /api/settings and media-instances siblings: the
  // value ships out on every safeFetchAdminConfigured call, so reject a bad
  // scheme or an embedded credential here rather than storing it verbatim and
  // echoing it back on GET. A url that is not text is left alone, as before;
  // an externalUrl is text, null (clear) or absent, nothing else.
  if (typeof inst.url === "string" && inst.url.trim().length > 0) {
    const err = validateServerUrl(inst.url.trim(), {}, t);
    if (err) return t("apiAdmin.arrInstances.invalidUrl", { slug, reason: err });
  }
  if (inst.externalUrl !== undefined && inst.externalUrl !== null) {
    if (typeof inst.externalUrl !== "string") {
      return t("apiAdmin.arrInstances.invalidUrl", { slug, reason: t("apiAdmin.serverUrl.invalid") });
    }
    if (inst.externalUrl.trim().length > 0) {
      const err = validateServerUrl(inst.externalUrl.trim(), {}, t);
      if (err) return t("apiAdmin.arrInstances.invalidUrl", { slug, reason: err });
    }
  }
  if (typeof inst.name === "string" && inst.name.trim().length > INSTANCE_NAME_MAX_LEN) {
    return t("apiAdmin.common.instanceNameTooLong", { slug, max: INSTANCE_NAME_MAX_LEN });
  }
  return null;
}

// null = explicit clear (the UI sends null for an emptied field); undefined = untouched.
const clearable = (v: string | number | null | undefined): string | undefined =>
  v === undefined ? undefined : v === null ? "" : String(v);

/**
 * The connection rows one validated instance writes, in write order: absent
 * fields are left as they are, "" clears a row, and a secret left at the mask
 * sentinel keeps the stored one. Encryption happens in the Prisma extension
 * (guardrail 7a) — never here.
 */
export function connectionWrites(inst: InstancePayload): Array<{ field: ArrSettingField; value: string }> {
  const rows: Array<[ArrSettingField, string | undefined, boolean]> = [
    ["Url", typeof inst.url === "string" ? inst.url.trim() : undefined, false],
    ["ExternalUrl", inst.externalUrl === undefined ? undefined : inst.externalUrl === null ? "" : inst.externalUrl.trim(), false],
    ["ApiKey", inst.apiKey, true],
    ["RootFolder", typeof inst.rootFolder === "string" ? inst.rootFolder : undefined, false],
    ["QualityProfileId", clearable(inst.qualityProfileId), false],
    ["MinimumAvailability", clearable(inst.minimumAvailability), false],
    ["LanguageProfileId", clearable(inst.languageProfileId), false],
    ["WebhookSecret", inst.webhookSecret, true],
  ];
  const out: Array<{ field: ArrSettingField; value: string }> = [];
  for (const [field, value, secret] of rows) {
    if (value === undefined) continue;
    if (secret && value === SECRET_MASK_SENTINEL) continue;
    out.push({ field, value });
  }
  return out;
}

/**
 * Whether a save changes what a connection test talks to: the address or the
 * key, compared with the rows stored before it. A save that only renames an
 * instance, moves its root folder or edits its routing tests nothing.
 */
export function connectionChanged(
  writes: ReadonlyArray<{ field: ArrSettingField; value: string }>,
  stored: { url: string | undefined; apiKey: string | undefined },
): boolean {
  for (const w of writes) {
    if (w.field === "Url" && w.value !== (stored.url ?? "")) return true;
    if (w.field === "ApiKey" && w.value !== (stored.apiKey ?? "")) return true;
  }
  return false;
}

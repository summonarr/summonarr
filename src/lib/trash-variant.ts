// The Radarr/Sonarr instance a TRaSH Guides route acts on, read ONE way by the
// status, spec-detail and apply routes: an instance slug ("" default, "4k", a
// named one), with "hd" accepted as the legacy spelling of the default.
import { isValidInstanceSlug } from "@/lib/arr-instances";
import type { ArrVariant } from "@/lib/arr";

// Absent ⇒ the default instance. Surrounding whitespace is trimmed BEFORE the
// legacy "hd" is recognised, so " hd " is the default everywhere. Anything
// else that is not a valid slug (a non-string included) is null: rejected,
// never silently routed to the default, so a UI bug can't rewrite the wrong
// instance.
export function parseTrashVariant(raw: unknown): ArrVariant | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const variant = trimmed === "hd" ? "" : trimmed;
  return isValidInstanceSlug(variant) ? variant : null;
}

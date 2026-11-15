// The TRaSH admin pages' shapes, and the runtime checks of what their routes
// answer (validate.ts). No directive: the pure outcome readers and the unit
// suite load it too.
import { v, type Schema } from "@/lib/validate";

export type TrashService = "RADARR" | "SONARR";

export const TRASH_SPEC_KINDS = [
  "CUSTOM_FORMAT",
  "CUSTOM_FORMAT_GROUP",
  "QUALITY_PROFILE",
  "NAMING",
  "QUALITY_SIZE",
] as const;
export type TrashSpecKind = (typeof TRASH_SPEC_KINDS)[number];

export interface TrashSettings {
  enabled: boolean;
  syncCustomFormats: boolean;
  syncCustomFormatGroups: boolean;
  syncQualityProfiles: boolean;
  syncNaming: boolean;
  syncQualitySizes: boolean;
}

// Each TRaSH sync switch: the field the Settings card holds, the Setting it is
// stored under, and its label. ONE table for the PATCH body and the rows, so a
// new sync kind can't be shown without being saved (or saved under the wrong
// key). The master switch comes first; the rest only matter while it is on.
export const TRASH_SYNC_TOGGLES = [
  { field: "enabled", settingKey: "trashGuidesEnabled", labelKey: "trash.sync.toggle.enabled.label", descriptionKey: "trash.sync.toggle.enabled.description" },
  { field: "syncCustomFormats", settingKey: "trashSyncCustomFormats", labelKey: "trash.sync.toggle.customFormats.label", descriptionKey: "trash.sync.toggle.customFormats.description" },
  { field: "syncCustomFormatGroups", settingKey: "trashSyncCustomFormatGroups", labelKey: "trash.sync.toggle.customFormatGroups.label", descriptionKey: "trash.sync.toggle.customFormatGroups.description" },
  { field: "syncQualityProfiles", settingKey: "trashSyncQualityProfiles", labelKey: "trash.sync.toggle.qualityProfiles.label", descriptionKey: "trash.sync.toggle.qualityProfiles.description" },
  { field: "syncNaming", settingKey: "trashSyncNaming", labelKey: "trash.sync.toggle.naming.label", descriptionKey: "trash.sync.toggle.naming.description" },
  { field: "syncQualitySizes", settingKey: "trashSyncQualitySizes", labelKey: "trash.sync.toggle.qualitySizes.label", descriptionKey: "trash.sync.toggle.qualitySizes.description" },
] as const satisfies ReadonlyArray<{ field: keyof TrashSettings; settingKey: string; labelKey: string; descriptionKey: string }>;

/** The PATCH /api/settings body for a change to some of the sync switches. */
export function trashSettingsPatch(change: Partial<TrashSettings>): Record<string, string> {
  const body: Record<string, string> = {};
  for (const { field, settingKey } of TRASH_SYNC_TOGGLES) {
    const value = change[field];
    if (value !== undefined) body[settingKey] = String(value);
  }
  return body;
}

export function sameTrashSettings(a: TrashSettings, b: TrashSettings): boolean {
  return TRASH_SYNC_TOGGLES.every(({ field }) => a[field] === b[field]);
}

export interface ApplicationStatus {
  id: string;
  enabled: boolean;
  remoteId: number | null;
  appliedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  errorCount: number;
}

export interface SpecStatus {
  id: string;
  service: TrashService;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  description: string | null;
  fetchedAt: string;
  application: ApplicationStatus | null;
}

export interface SpecDetail extends SpecStatus {
  upstreamPath: string;
  upstreamSha: string | null;
  payload: Record<string, unknown>;
}

export interface ApplyResult {
  specId: string;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  ok: boolean;
  remoteId?: number;
  error?: string;
  recreated?: boolean;
}

export type ActionState = "idle" | "running" | "ok" | "error";

/** What a run's banner lists: its failures, and the db-push hint when the schema is behind. */
export interface RunError {
  errors: string[];
  schemaDiagnostic?: string;
}

export interface StarterPackItem {
  item: {
    service: TrashService;
    kind: TrashSpecKind;
    // English fallbacks; the row renders labelKey/rationaleKey via t() when set
    // (see src/lib/trash-recommendations.ts).
    label: string;
    rationale: string;
    labelKey?: string;
    labelVars?: Record<string, string>;
    rationaleKey?: string;
    recommended: boolean;
  };
  spec: { id: string; name: string; trashId: string } | null;
  application: { enabled: boolean; appliedAt: string | null; lastError: string | null } | null;
}

// Catalog keys, translated at render time.
export const KIND_LABEL_KEY: Record<TrashSpecKind, string> = {
  CUSTOM_FORMAT: "trash.kind.customFormat",
  CUSTOM_FORMAT_GROUP: "trash.kind.customFormatGroup",
  QUALITY_PROFILE: "trash.kind.qualityProfile",
  NAMING: "trash.kind.naming",
  QUALITY_SIZE: "trash.kind.qualitySize",
};

// ── runtime checks of the routes' answers ────────────────────────────────────
// Each names exactly the fields the cards read (v.object drops the rest). A
// typed annotation keeps each in step with its interface above.

const SERVICE = v.literal("RADARR", "SONARR");
const KIND = v.literal(...TRASH_SPEC_KINDS);

const APPLICATION_STATUS: Schema<ApplicationStatus> = v.object({
  id: v.string(),
  enabled: v.boolean(),
  remoteId: v.nullable(v.number()),
  appliedAt: v.nullable(v.string()),
  lastError: v.nullable(v.string()),
  lastErrorAt: v.nullable(v.string()),
  errorCount: v.number(),
});

const SPEC_STATUS_FIELDS = {
  id: v.string(),
  service: SERVICE,
  kind: KIND,
  trashId: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  fetchedAt: v.string(),
  application: v.nullable(APPLICATION_STATUS),
};

export const SPEC_STATUS: Schema<SpecStatus> = v.object(SPEC_STATUS_FIELDS);

/** GET /api/admin/trash-guides/status. */
export const SPEC_STATUS_ANSWER = v.object({
  specs: v.optional(v.array(SPEC_STATUS)),
  // Sent WITH a 200 and an empty list when the TRaSH tables are missing (the
  // schema was never pushed): the list is unreadable, not empty.
  schemaDiagnostic: v.optional(v.string()),
});

/** GET /api/admin/trash-guides/spec/{id}. The payload is TRaSH's own JSON, read field by field by the detail views. */
export const SPEC_DETAIL_ANSWER: Schema<SpecDetail> = v.object({
  ...SPEC_STATUS_FIELDS,
  upstreamPath: v.string(),
  upstreamSha: v.nullable(v.string()),
  payload: v.record(v.unknown()),
});

/** One spec's apply result, from the apply route and the trash-sync cron alike. */
export const APPLY_RESULT: Schema<ApplyResult> = v.object({
  specId: v.string(),
  kind: KIND,
  trashId: v.string(),
  name: v.string(),
  ok: v.boolean(),
  remoteId: v.optional(v.number()),
  error: v.optional(v.string()),
  recreated: v.optional(v.boolean()),
});

const STARTER_PACK_ITEM: Schema<StarterPackItem> = v.object({
  item: v.object({
    service: SERVICE,
    kind: KIND,
    label: v.string(),
    rationale: v.string(),
    labelKey: v.optional(v.string()),
    labelVars: v.optional(v.record(v.string())),
    rationaleKey: v.optional(v.string()),
    recommended: v.boolean(),
  }),
  spec: v.nullable(v.object({ id: v.string(), name: v.string(), trashId: v.string() })),
  application: v.nullable(v.object({ enabled: v.boolean(), appliedAt: v.nullable(v.string()), lastError: v.nullable(v.string()) })),
});

/** GET /api/admin/trash-guides/starter-pack. */
export const STARTER_PACK_ANSWER = v.object({
  items: v.optional(v.array(STARTER_PACK_ITEM)),
  schemaDiagnostic: v.optional(v.string()),
});

export type TrashService = "RADARR" | "SONARR";

export type TrashSpecKind =
  | "CUSTOM_FORMAT"
  | "CUSTOM_FORMAT_GROUP"
  | "QUALITY_PROFILE"
  | "NAMING"
  | "QUALITY_SIZE";

export interface TrashSettings {
  enabled: boolean;
  syncCustomFormats: boolean;
  syncCustomFormatGroups: boolean;
  syncQualityProfiles: boolean;
  syncNaming: boolean;
  syncQualitySizes: boolean;
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

export type LoadState = "idle" | "loading" | "ready" | "error";
export type ActionState = "idle" | "running" | "ok" | "error";

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

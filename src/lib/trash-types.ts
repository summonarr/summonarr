// The TRaSH-Guides payload shapes as stored in TrashSpec.payload, and the
// per-spec apply result. Type-only on purpose: the validators
// (trash-validators.ts), the refresh and every applier import these without
// pulling in prisma or the arr client.
import type { TrashSpecKind } from "@/generated/prisma";

export interface TrashCustomFormat {
  trash_id: string;
  trash_scores?: Record<string, number>;
  name: string;
  includeCustomFormatWhenRenaming?: boolean | null;
  specifications?: unknown[];
  [k: string]: unknown;
}

export interface TrashCustomFormatGroupMember {
  name?: string | null;
  trash_id: string;
  required?: boolean | null;
}

export interface TrashCustomFormatGroup {
  trash_id: string;
  name: string;
  trash_description?: string | null;
  default?: string;
  custom_formats: TrashCustomFormatGroupMember[];
  quality_profiles?: { include?: Record<string, string> };
  [k: string]: unknown;
}

export interface TrashQualitySize {
  trash_id: string;
  type?: string | null;
  qualities: Array<{
    quality: string;
    min: number;
    preferred?: number;
    max: number;
  }>;
}

export interface TrashQualityProfile {
  trash_id: string;
  trash_description?: string | null;
  trash_url?: string;
  name: string;
  upgradeAllowed?: boolean | null;
  cutoff?: string | null;
  cutoffFormatScore?: number | null;
  minFormatScore?: number | null;
  minUpgradeFormatScore?: number | null;
  language?: string | null;
  score_set?: string | null;
  items?: Array<{
    name: string;
    allowed: boolean;
    items?: string[];
  }>;
  formatItems?: Record<string, string>;
  [k: string]: unknown;
}

export interface ApplyResult {
  specId: string;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  ok: boolean;
  remoteId?: number;
  error?: string;
  // True when the apply landed via a POST after a PUT-404 (Arr resource was deleted out-of-band).
  // Surfaced to the UI and audit log so admins can tell drift recovery from normal applies.
  recreated?: boolean;
  // QUALITY_SIZE only: every quality this spec sets was set again by a later
  // spec in the same merge (see applyQualitySizes), so none of its values were
  // sent. The names are those later specs'.
  supersededBy?: string[];
}

// The identity of a spec an apply records a result for.
export interface SpecIdentity {
  id: string;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
}

// The lock's AbortSignal (guardrail 41), threaded from the cron and the admin
// write routes into every applier.
export interface ApplyOptions {
  signal?: AbortSignal;
}

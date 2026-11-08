// The named Radarr/Sonarr instance manager's data (arr-instances-manager.tsx):
// the GET/POST answers of /api/admin/arr-instances read through a shape check,
// the editable draft, and the save payload. Pure and React-free so the unit
// suite runs it directly (tests/instance-managers-wiring.test.mts).
import { check, v, type Infer } from "@/lib/validate";
import { DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE, isValidInstanceSlug } from "@/lib/arr-instances";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";

export type ArrService = "radarr" | "sonarr";

const InstanceViewSchema = v.object({
  slug: v.string(),
  name: v.string(),
  restricted: v.boolean(),
  serverAll: v.boolean(),
  skipLibraryCheck: v.boolean(),
  autoRoute: v.nullable(v.object({ animeOnly: v.optional(v.boolean()) })),
  url: v.string(),
  // Absent on an older server's response.
  externalUrl: v.optional(v.string()),
  rootFolder: v.string(),
  qualityProfileId: v.string(),
  minimumAvailability: v.optional(v.string()),
  languageProfileId: v.optional(v.string()),
  hasApiKey: v.boolean(),
  hasWebhookSecret: v.boolean(),
});

export type InstanceView = Infer<typeof InstanceViewSchema>;

export type TestResult = { version?: string; error?: string };

export interface Draft {
  // A client-only identity per draft card (never sent): the list, the "copied"
  // check and the pending Remove are keyed by it, so removing one card can't
  // hand another card's state to its neighbour.
  id: number;
  slug: string;
  name: string;
  url: string;
  // The address a browser uses ("Open in Radarr" links); "" = use `url`.
  externalUrl: string;
  apiKey: string;
  rootFolder: string;
  qualityProfileId: string;
  minimumAvailability: string; // radarr only
  languageProfileId: string; // sonarr v3 only
  webhookSecret: string;
  restricted: boolean;
  serverAll: boolean;
  skipLibraryCheck: boolean;
  animeOnly: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  isNew: boolean;
}

// Bumped only from handlers and effects, never during a render.
let lastDraftId = 0;
export const nextDraftId = () => ++lastDraftId;

// Only named instances are managed here — the default ("") and legacy 4K ("4k")
// have their own forms.
export const isNamed = (slug: string) => slug !== DEFAULT_ARR_INSTANCE && slug !== FOURK_ARR_INSTANCE;

export function toDraft(view: InstanceView): Draft {
  return {
    id: nextDraftId(),
    slug: view.slug,
    name: view.name,
    url: view.url,
    externalUrl: view.externalUrl ?? "",
    apiKey: "",
    rootFolder: view.rootFolder,
    qualityProfileId: view.qualityProfileId,
    minimumAvailability: view.minimumAvailability ?? "",
    languageProfileId: view.languageProfileId ?? "",
    webhookSecret: "",
    restricted: view.restricted,
    serverAll: view.serverAll,
    skipLibraryCheck: view.skipLibraryCheck,
    animeOnly: view.autoRoute?.animeOnly === true,
    hasApiKey: view.hasApiKey,
    hasWebhookSecret: view.hasWebhookSecret,
    isNew: false,
  };
}

/** A new, unsaved card. `webhookSecret` is made by the caller (browser-only). */
export function newDraft(webhookSecret: string): Draft {
  return {
    id: nextDraftId(), slug: "", name: "", url: "", externalUrl: "", apiKey: "", rootFolder: "", qualityProfileId: "",
    minimumAvailability: "", languageProfileId: "", webhookSecret,
    restricted: false, serverAll: false, skipLibraryCheck: false, animeOnly: false,
    hasApiKey: false, hasWebhookSecret: false, isNew: true,
  };
}

export interface InstanceList {
  named: InstanceView[];
  version: string | undefined;
}

/**
 * The service's named instances from a GET or POST answer, or null when the
 * list isn't one. The whole list is refused, never filtered: saving a list
 * with an instance silently dropped would delete it and its secrets.
 */
export function readInstanceList(list: unknown, version: unknown): InstanceList | null {
  const r = check(v.array(InstanceViewSchema), list ?? []);
  if (!r.ok) return null;
  return { named: r.value.filter((i) => isNamed(i.slug)), version: typeof version === "string" ? version : undefined };
}

/** GET /api/admin/arr-instances for one service. */
export function readInstancesGet(data: unknown, service: ArrService): InstanceList | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const versions = d.versions && typeof d.versions === "object" ? (d.versions as Record<string, unknown>) : {};
  return readInstanceList(d[service], versions[service]);
}

export interface SaveAnswer extends InstanceList {
  testResults: Record<string, TestResult>;
  // Removed instances that still had PENDING/APPROVED requests (additive on the
  // wire — an older server omits `removed`).
  stranded: Array<{ slug: string; openRequests: number }>;
}

const TestResultsSchema = v.record(v.object({ version: v.optional(v.string()), error: v.optional(v.string()) }));
const RemovedSchema = v.array(v.object({ slug: v.string(), openRequests: v.number() }));

/** A successful POST's answer, or null when it isn't one. */
export function readSaveAnswer(data: Record<string, unknown>): SaveAnswer | null {
  const list = readInstanceList(data.instances, data.version);
  if (!list) return null;
  const tests = check(TestResultsSchema, data.testResults ?? {});
  const removed = check(RemovedSchema, data.removed ?? []);
  return {
    ...list,
    testResults: tests.ok ? tests.value : {},
    stranded: removed.ok ? removed.value.filter((r) => r.openRequests > 0) : [],
  };
}

/**
 * Why the drafts can't be saved, checked before anything is sent — with the
 * server's own slug rule (it refuses "hd", and "external", whose keys are the
 * default instance's), minus the built-ins this manager never edits.
 */
export function draftsProblem(drafts: Draft[]): { kind: "invalid" | "duplicate"; slug: string } | null {
  for (const d of drafts) {
    if (!isNamed(d.slug) || !isValidInstanceSlug(d.slug)) return { kind: "invalid", slug: d.slug };
  }
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.slug)) return { kind: "duplicate", slug: d.slug };
    seen.add(d.slug);
  }
  return null;
}

/** The POST body's `instances`: a blank secret over a saved one sends the mask ("keep it"). */
export function instancesPayload(drafts: Draft[], service: ArrService) {
  return drafts.map((d) => ({
    slug: d.slug,
    name: d.name.trim() || d.slug,
    url: d.url.trim(),
    // null clears it (the links fall back to the connection URL).
    externalUrl: d.externalUrl.trim() || null,
    apiKey: d.apiKey ? d.apiKey : d.hasApiKey ? SECRET_MASK_SENTINEL : undefined,
    rootFolder: d.rootFolder,
    qualityProfileId: d.qualityProfileId || null,
    // null deletes the saved value, so an empty dropdown means "use Radarr's/Sonarr's own default".
    ...(service === "radarr" ? { minimumAvailability: d.minimumAvailability || null } : {}),
    ...(service === "sonarr" ? { languageProfileId: d.languageProfileId || null } : {}),
    webhookSecret: d.webhookSecret ? d.webhookSecret : d.hasWebhookSecret ? SECRET_MASK_SENTINEL : undefined,
    restricted: d.restricted,
    serverAll: d.serverAll,
    skipLibraryCheck: d.skipLibraryCheck,
    autoRoute: d.animeOnly ? { animeOnly: true } : null,
  }));
}

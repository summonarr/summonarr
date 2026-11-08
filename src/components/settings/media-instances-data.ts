// The named Plex/Jellyfin server manager's data (media-instances-manager.tsx):
// the GET/POST answers of /api/admin/media-instances read through a shape
// check, the editable draft, and the save payload. Pure and React-free so the
// unit suite runs it directly (tests/media-instances-data.test.mts). The arr
// manager's twin is arr-instances-data.ts.
import { check, v, type Infer } from "@/lib/validate";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, mediaInstanceSlugCollidesWithDefault } from "@/lib/media-instances";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";

export type MediaServerService = "plex" | "jellyfin";

const InstanceViewSchema = v.object({
  slug: v.string(),
  name: v.string(),
  serverUrl: v.optional(v.string()), // plex
  adminEmail: v.optional(v.string()), // plex
  hasAdminToken: v.optional(v.boolean()), // plex
  url: v.optional(v.string()), // jellyfin
  hasApiKey: v.optional(v.boolean()), // jellyfin
  // jellyfin — the per-instance `jellyfin<Slug>RestrictSignIn` policy read by
  // isJellyfinSignInAllowed. The API resolves an absent Setting row to `true`,
  // matching auth.ts's fail-closed default.
  restrictSignIn: v.optional(v.boolean()),
  // BOTH services — gate this server's library behind a per-user `view` grant
  // (User.mediaServerGrants → canViewMediaInstance). Registry metadata, not a
  // Setting row. Round-tripped straight back through POST, so the draft carries
  // it (toDraft reads anything but `true` as open).
  restricted: v.optional(v.boolean()),
  // Comma-joined library ids/section keys to sync from THIS server. "" = sync
  // everything. Round-tripped like `restricted`, so it must be carried through
  // the draft: sending "" would clear a real selection.
  libraries: v.optional(v.string()),
  // Per-server Movie/Tv path-strip prefixes. "" on the wire means "no row" —
  // the server inherits the DEFAULT instance's prefixes. Saving "" deletes the
  // per-server row to restore that inheritance, so blank is safe to round-trip.
  moviePathStripPrefix: v.optional(v.string()),
  tvPathStripPrefix: v.optional(v.string()),
});

export type InstanceView = Infer<typeof InstanceViewSchema>;

export type TestResult = { ok?: boolean; error?: string };

export interface Draft {
  // A client-only identity per card (never sent): the cards and the pending
  // Remove are keyed by it, so removing one card can't hand its state (or its
  // focus) to the next one. The slug can't serve: it is editable while `isNew`.
  id: number;
  slug: string;
  name: string;
  url: string; // serverUrl (plex) or url (jellyfin) — one field, label varies
  token: string; // adminToken (plex) or apiKey (jellyfin)
  adminEmail: string; // plex only
  restrictSignIn: boolean; // jellyfin only
  restricted: boolean; // both services — per-user view grant required
  hasToken: boolean;
  isNew: boolean;
  libraries: string;
  moviePathStripPrefix: string;
  tvPathStripPrefix: string;
}

// Bumped only from handlers and effects, never during a render.
let lastDraftId = 0;
const nextDraftId = () => ++lastDraftId;

// Only named instances are managed here — the default ("") has its own form.
export const isNamed = (slug: string) => slug !== DEFAULT_MEDIA_INSTANCE;

export function toDraft(view: InstanceView, service: MediaServerService): Draft {
  return {
    id: nextDraftId(),
    slug: view.slug,
    name: view.name,
    url: (service === "plex" ? view.serverUrl : view.url) ?? "",
    token: "",
    adminEmail: view.adminEmail ?? "",
    // Fail closed on anything we can't read as an explicit `false` — same
    // default as isJellyfinSignInAllowed, so the checkbox can never render
    // unchecked (= "anyone may sign in") for a server that is actually
    // restricted.
    restrictSignIn: view.restrictSignIn ?? true,
    libraries: view.libraries ?? "",
    // Strict === true, matching the registry normalizer this value came from
    // (media-instance-registry.ts). Unlike restrictSignIn the safe default is
    // OPEN: a restricted server nobody has been granted is invisible to every
    // non-admin, so guessing "restricted" from a malformed response would blank
    // the library instead of merely widening access.
    restricted: view.restricted === true,
    hasToken: (service === "plex" ? view.hasAdminToken : view.hasApiKey) ?? false,
    isNew: false,
    moviePathStripPrefix: view.moviePathStripPrefix ?? "",
    tvPathStripPrefix: view.tvPathStripPrefix ?? "",
  };
}

/** A new, unsaved card. */
export function newDraft(): Draft {
  return {
    id: nextDraftId(),
    // restrictSignIn defaults to true — a brand-new server starts fail-closed,
    // matching isJellyfinSignInAllowed's default for an absent Setting row.
    // `restricted` defaults to FALSE for the opposite reason: an unrestricted
    // server is the status quo, and a restricted one with no grants yet issued
    // would be invisible to every non-admin the moment it finished syncing.
    slug: "", name: "", url: "", token: "", adminEmail: "", restrictSignIn: true, restricted: false,
    hasToken: false, isNew: true, libraries: "", moviePathStripPrefix: "", tvPathStripPrefix: "",
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

/** GET /api/admin/media-instances for one service. */
export function readInstancesGet(data: unknown, service: MediaServerService): InstanceList | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const versions = d.versions && typeof d.versions === "object" ? (d.versions as Record<string, unknown>) : {};
  return readInstanceList(d[service], versions[service]);
}

export interface SaveAnswer extends InstanceList {
  testResults: Record<string, TestResult>;
}

const TestResultsSchema = v.record(v.object({ ok: v.optional(v.boolean()), error: v.optional(v.string()) }));

/** A successful POST's answer ({ ok: true, instances, testResults, version }), or null when it isn't one. */
export function readSaveAnswer(data: unknown): SaveAnswer | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return null;
  const list = readInstanceList(d.instances, d.version);
  if (!list) return null;
  const tests = check(TestResultsSchema, d.testResults ?? {});
  return { ...list, testResults: tests.ok ? tests.value : {} };
}

/**
 * Why the drafts can't be saved, checked before anything is sent — the
 * server's own slug rule, minus the default ("") this manager never edits.
 */
export function draftsProblem(drafts: Draft[]): { kind: "invalid" | "duplicate" | "reserved"; slug: string } | null {
  for (const d of drafts) {
    if (!isNamed(d.slug) || !isValidMediaInstanceSlug(d.slug)) return { kind: "invalid", slug: d.slug };
  }
  // A new server's slug must not derive a main-server Setting key; the server
  // refuses it too (a saved one stays accepted).
  for (const d of drafts) {
    if (d.isNew && mediaInstanceSlugCollidesWithDefault(d.slug)) return { kind: "reserved", slug: d.slug };
  }
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.slug)) return { kind: "duplicate", slug: d.slug };
    seen.add(d.slug);
  }
  return null;
}

/**
 * The secret to send: the typed one, trimmed (a token pasted with a trailing
 * newline would be stored that way and fail to authenticate); the mask when
 * the field is blank over a saved one ("keep it"); nothing otherwise.
 */
function secretField(d: Draft): string | undefined {
  const typed = d.token.trim();
  if (typed) return typed;
  return d.hasToken ? SECRET_MASK_SENTINEL : undefined;
}

/** The POST body's `instances`. The draft id is client-only and never sent. */
export function instancesPayload(drafts: Draft[], service: MediaServerService) {
  return drafts.map((d) => ({
    slug: d.slug,
    name: d.name.trim() || d.slug,
    // Outside the per-service spread on purpose: visibility is the one access
    // field BOTH services share (restrictSignIn below is Jellyfin-only).
    restricted: d.restricted,
    libraries: d.libraries,
    moviePathStripPrefix: d.moviePathStripPrefix,
    tvPathStripPrefix: d.tvPathStripPrefix,
    ...(service === "plex"
      ? {
          serverUrl: d.url.trim(),
          adminToken: secretField(d),
          adminEmail: d.adminEmail.trim(),
        }
      : {
          url: d.url.trim(),
          apiKey: secretField(d),
          restrictSignIn: d.restrictSignIn,
        }),
  }));
}

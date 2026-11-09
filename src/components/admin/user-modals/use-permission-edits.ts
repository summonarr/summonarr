"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PRESETS, parsePermissions } from "@/lib/permissions";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import { requestFailureText } from "../request-failure-text";
import { createFieldSave, type FieldSave } from "./field-save";
import type { InstanceGrantMap, MediaServerGrants, User } from "./shared";

// The permissions editor's state and saves. Every change works the same way:
// the field shows the new value at once, and its FieldSave (field-save.ts)
// PATCHes it — one field per request, as the route takes it — after any save
// of that field still in flight. A refusal puts the field back to the server's
// value and shows the route's reason, because some refusals are things an
// admin does on purpose and needs explained:
//   • clearing the last permission bit sends a mask of 0, which the route
//     rejects with a sentence explaining what to do instead;
//   • a quota limit of 0 is rejected because 0 already means "unlimited" —
//     the response spells out the real alternatives;
//   • the route allows 20 PATCHes a minute and this editor has up to 18
//     switches, so an admin clicking steadily down the list can hit its 429.
// Changes queue rather than being ignored while a save is out, so no switch
// ever drops a click. The users page is re-read ONCE, when the editor closes
// after something was saved, not after every switch.

export type QuotaField = "movieQuotaLimit" | "movieQuotaDays" | "tvQuotaLimit" | "tvQuotaDays";
export const QUOTA_FIELDS: readonly QuotaField[] = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"];
export type QuotaText = Record<QuotaField, string>;

const formatQuota = (value: number | null) => value?.toString() ?? "";

/** A quota field's typed text as the value the route takes: null (cleared), a whole number ≥ 0, or NaN for junk. */
export function parseQuotaText(raw: string): number | null {
  const trimmed = raw.trim();
  // "2.7" is sent as 2 and "-3" as 0; text that is not a number (or too large
  // to be one, 1e400) comes out non-finite.
  return trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
}

interface Savers {
  permissions: FieldSave<bigint>;
  instanceGrants: FieldSave<InstanceGrantMap>;
  mediaServerGrants: FieldSave<MediaServerGrants>;
  maxContentRating: FieldSave<string>;
  quota: Record<QuotaField, FieldSave<number | null>>;
}

interface SaverSetters {
  setPerms: (v: bigint) => void;
  setGrants: (v: InstanceGrantMap) => void;
  setMediaGrants: (v: MediaServerGrants) => void;
  setMaxRating: (v: string) => void;
  setQuota: (update: (q: QuotaText) => QuotaText) => void;
}

// One FieldSave per editable field, starting from what the server holds. A
// refusal puts the shown value back (`revert`); a quota field's text only
// while it still shows the refused value, so newer typing is kept.
function createSavers(u: User, send: (body: Record<string, unknown>) => Promise<boolean>, set: SaverSetters): Savers {
  const quotaSave = (field: QuotaField, initial: number | null) =>
    createFieldSave<number | null>({
      initial,
      send: (value) => send({ [field]: value }),
      revert: (sent, saved) =>
        set.setQuota((q) => (q[field] === formatQuota(sent) ? { ...q, [field]: formatQuota(saved) } : q)),
    });
  return {
    permissions: createFieldSave({
      initial: parsePermissions(u.permissions),
      send: (mask) => send({ permissions: mask.toString() }),
      revert: (_sent, saved) => set.setPerms(saved),
    }),
    instanceGrants: createFieldSave({
      initial: u.instanceGrants,
      send: (map) => send({ instanceGrants: map }),
      revert: (_sent, saved) => set.setGrants(saved),
    }),
    mediaServerGrants: createFieldSave({
      initial: u.mediaServerGrants,
      send: (map) => send({ mediaServerGrants: map }),
      revert: (_sent, saved) => set.setMediaGrants(saved),
    }),
    maxContentRating: createFieldSave({
      initial: u.maxContentRating ?? "",
      send: (cap) => send({ maxContentRating: cap === "" ? null : cap }),
      revert: (_sent, saved) => set.setMaxRating(saved),
    }),
    quota: {
      movieQuotaLimit: quotaSave("movieQuotaLimit", u.movieQuotaLimit ?? null),
      movieQuotaDays: quotaSave("movieQuotaDays", u.movieQuotaDays ?? null),
      tvQuotaLimit: quotaSave("tvQuotaLimit", u.tvQuotaLimit ?? null),
      tvQuotaDays: quotaSave("tvQuotaDays", u.tvQuotaDays ?? null),
    },
  };
}

export function usePermissionEdits(u: User) {
  const t = useT();
  const router = useRouter();
  const [perms, setPerms] = useState<bigint>(() => parsePermissions(u.permissions));
  const [grants, setGrants] = useState<InstanceGrantMap>(u.instanceGrants);
  const [mediaGrants, setMediaGrants] = useState<MediaServerGrants>(u.mediaServerGrants);
  const [maxRating, setMaxRating] = useState<string>(u.maxContentRating ?? "");
  const [quota, setQuota] = useState<QuotaText>({
    movieQuotaLimit: formatQuota(u.movieQuotaLimit),
    movieQuotaDays: formatQuota(u.movieQuotaDays),
    tvQuotaLimit: formatQuota(u.tvQuotaLimit),
    tvQuotaDays: formatQuota(u.tvQuotaDays),
  });
  // PATCHes in flight, for the "Saving…" line. A counter, not a boolean: one
  // field's save finishing must not hide another's still out.
  const [pending, setPending] = useState(0);
  const saving = pending > 0;
  // The last refusal and the field it was about: another field's later save
  // must not hide it; only the same field saving clears it.
  const [failure, setFailure] = useState<{ field: string; text: string } | null>(null);
  const error = failure?.text ?? null;
  // Something was saved since the editor opened: the page is re-read on close.
  const savedAny = useRef(false);

  // One PATCH of one field. Resolves true when the server took it; a refusal
  // shows the route's own reason (fetchJson's apiErrorText) or its status.
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    const field = Object.keys(body)[0] ?? "";
    setPending((n) => n + 1);
    const res = await fetchJson(withBasePath(`/api/admin/users/${u.id}`), { init: jsonInit("PATCH", body) });
    setPending((n) => n - 1);
    if (res.ok) {
      savedAny.current = true;
      setFailure((f) => (f?.field === field ? null : f));
      return true;
    }
    const text = requestFailureText(res, t, { status: "adminManage.notif.failed", network: "adminManage.users.error.network" });
    if (text !== null) setFailure({ field, text });
    return false;
  }
  const patchRef = useRef(patch);
  useEffect(() => {
    patchRef.current = patch;
  });

  // Built on the first change (never during render) and kept for the editor's
  // lifetime; they reach the newest `patch` (and so the newest translator)
  // through patchRef.
  const saversRef = useRef<Savers | null>(null);
  function savers(): Savers {
    saversRef.current ??= createSavers(u, (body) => patchRef.current(body), { setPerms, setGrants, setMediaGrants, setMaxRating, setQuota });
    return saversRef.current;
  }

  // Each change builds on the field's LATEST value (the saver's), never on a
  // render's possibly older copy.
  function toggle(bit: bigint) {
    const cur = savers().permissions.value;
    const next = (cur & bit) !== 0n ? cur & ~bit : cur | bit;
    setPerms(next);
    void savers().permissions.set(next);
  }

  function applyPreset() {
    const next = PRESETS[u.role] ?? PRESETS.USER;
    setPerms(next);
    void savers().permissions.set(next);
  }

  function toggleGrant(slug: string, field: "request" | "autoApprove") {
    const cur = savers().instanceGrants.value;
    const next: InstanceGrantMap = { ...cur, [slug]: { ...cur[slug], [field]: !cur[slug]?.[field] } };
    setGrants(next);
    void savers().instanceGrants.set(next);
  }

  // Visibility grant on a RESTRICTED Plex/Jellyfin server. Service-namespaced —
  // the two service maps are written independently so granting plex:remote can
  // never touch a jellyfin instance that happens to share the slug.
  function toggleMediaGrant(service: "plex" | "jellyfin", slug: string) {
    const cur = savers().mediaServerGrants.value;
    const serviceMap = { ...(cur[service] ?? {}) };
    serviceMap[slug] = { view: serviceMap[slug]?.view !== true };
    const next: MediaServerGrants = { ...cur, [service]: serviceMap };
    setMediaGrants(next);
    void savers().mediaServerGrants.set(next);
  }

  function saveMaxRating(value: string) {
    setMaxRating(value);
    void savers().maxContentRating.set(value);
  }

  function setQuotaText(field: QuotaField, text: string) {
    setQuota((q) => ({ ...q, [field]: text }));
  }

  // On blur or Enter. Resolves true when there was nothing to save or the
  // server took it. Tabbing through the inputs sends nothing: an unchanged
  // value is no request (each PATCH writes an audit row and spends the
  // 20-per-minute limit the switches share).
  function saveQuota(field: QuotaField, raw: string): Promise<boolean> {
    const value = parseQuotaText(raw);
    const saver = savers().quota[field];
    if (value !== null && !Number.isFinite(value)) {
      // Not a number: nothing is saved, so say so and put back the field's
      // value rather than leave unsaved text looking committed (and blocking
      // every close after this one).
      setQuota((q) => ({ ...q, [field]: formatQuota(saver.value) }));
      setFailure({ field, text: t("adminManage.perm.quota.invalid") });
      return Promise.resolve(false);
    }
    // Show what is saved: "2.7" is sent as 2 and "-3" as 0.
    setQuota((q) => ({ ...q, [field]: formatQuota(value) }));
    return saver.set(value);
  }

  // Closing unmounts the quota inputs without their onBlur, so a value just
  // typed is saved here first; then every field's saves are waited on. True
  // once all of them landed, and only then is the page re-read. A refusal
  // (a quota limit of 0, a 429, the network) keeps the editor open with its
  // error, instead of failing on a component nobody sees.
  const quotaRef = useRef(quota);
  useEffect(() => {
    quotaRef.current = quota;
  });
  async function flush(): Promise<boolean> {
    const started = QUOTA_FIELDS.map((field) => saveQuota(field, quotaRef.current[field]));
    const { permissions, instanceGrants, mediaServerGrants, maxContentRating } = savers();
    const others = [permissions, instanceGrants, mediaServerGrants, maxContentRating];
    const results = await Promise.all([...started, ...others.map((f) => f.settled())]);
    if (!results.every(Boolean)) return false;
    if (savedAny.current) {
      savedAny.current = false;
      router.refresh();
    }
    return true;
  }

  return {
    perms, grants, mediaGrants, maxRating, quota, saving, error,
    toggle, applyPreset, toggleGrant, toggleMediaGrant, saveMaxRating, setQuotaText, saveQuota, flush,
  };
}

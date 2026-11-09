"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import {
  Plus,
  Check,
  Loader2,
  PlayCircle,
  Tv2,
  Clock,
  MessageSquare,
  X,
  AlertCircle,
  Ban,
} from "@/components/icons";
import Link from "next/link";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { v } from "@/lib/validate";
import { REQUEST_NOTE_MAX } from "@/lib/request-limits";
import { SLOT } from "@/lib/i18n/slot";
import { SlotText } from "@/components/i18n/slot-text";
import { submitMediaRequest } from "@/lib/client/media-request";
import { StyledSelect } from "@/components/ui/styled-select";
import { Textarea } from "@/components/ui/textarea";
import {
  DetailActionButton,
  DetailActionStatus,
  DETAIL_ACTION_CLASS,
  detailActionStyle,
} from "./detail-action-button";

type State =
  | "idle"
  | "confirm"
  | "note"
  | "loading"
  | "requested"
  | "duplicate"
  | "onbehalf"
  | "error";

interface RequestButtonProps {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  showPlex?: boolean;
  showJellyfin?: boolean;

  // CSRF token generated server-side; the API rejects mutation requests that lack it
  requestToken?: string;

  // When true, show a "Request for user…" affordance (REQUEST_ON_BEHALF holders).
  // The on-behalf path posts to /api/requests/bulk, which re-checks the permission.
  canRequestOnBehalf?: boolean;

  // When true, offer a request-time quality-profile picker (REQUEST_ADVANCED holders).
  // The chosen id rides the POST body; the API re-checks the permission + validates it.
  canChooseProfile?: boolean;

  // When true, the title is admin-blacklisted: show an "unavailable to request"
  // state instead of the request CTA. The request POST 403s regardless.
  blacklisted?: boolean;

  // When false, hide the HD request CTA (the viewer cannot request this media
  // type on the default instance). Availability / queued / already-requested
  // status still renders — those are not the CTA. Default true so a missed
  // callsite cannot silently strip the button from someone who CAN request.
  canRequest?: boolean;
}

// Per-item outcome → status line for the on-behalf flow. The keys mirror the
// bulk pipeline's `ItemResult` union (src/lib/request-bulk.ts) and
// tests/request-button-on-behalf.test.mts pins the two in step. Every outcome
// used to collapse into "Already requested or available", which was false for
// no-permission (target lacks the instance grant), rating-blocked, blacklisted
// and error — the requester never learned the real reason.
// Values are i18n keys (request.json); the caller translates them.
export const ON_BEHALF_MESSAGES: Record<string, string> = {
  created: "request.onBehalf.created",
  "auto-approved": "request.onBehalf.autoApproved",
  "already-available": "request.onBehalf.alreadyAvailable",
  "already-requested": "request.onBehalf.alreadyRequested",
  "skipped-declined": "request.onBehalf.skippedDeclined",
  "no-permission": "request.onBehalf.noPermission",
  blacklisted: "request.onBehalf.blacklisted",
  "rating-blocked": "request.onBehalf.ratingBlocked",
  error: "request.onBehalf.error",
};

// Outcomes that mean the on-behalf request did NOT go through — shown in the
// danger colour like every other request button's error line. The already-*
// outcomes are neutral (nothing failed; there was simply nothing to do).
const ON_BEHALF_FAILURES = new Set([
  "skipped-declined",
  "no-permission",
  "blacklisted",
  "rating-blocked",
  "error",
]);

// Pure: resolves the status line from the bulk response. `result` is the first
// item's outcome; `created` is the fallback for an older server whose response
// carries no `results` array. Returns an i18n key.
export function onBehalfMessage(result: string | undefined, created: number | undefined): string {
  if (result !== undefined && Object.hasOwn(ON_BEHALF_MESSAGES, result)) {
    return ON_BEHALF_MESSAGES[result];
  }
  return created ? ON_BEHALF_MESSAGES.created : "request.onBehalf.collapsed";
}

type Translate = ReturnType<typeof useT>;
type MediaType = "MOVIE" | "TV";

const ICON = { width: 14, height: 14 } as const;

// GET /api/requests/quality-profiles.
const ProfilesAnswer = v.object({
  qualityProfiles: v.array(v.object({ id: v.int(), name: v.string() })),
});
type QualityProfile = { id: number; name: string };

// GET /api/requests/users (another account's email arrives masked for a
// non-admin; `truncated` is not read here).
const UsersAnswer = v.object({
  users: v.optional(v.array(v.object({ id: v.string(), name: v.nullable(v.string()), email: v.string() }))),
});
type OnBehalfUser = { id: string; name: string | null; email: string };

// POST /api/requests/bulk.
const BulkAnswer = v.object({
  created: v.optional(v.number()),
  results: v.optional(v.array(v.object({ result: v.optional(v.string()) }))),
});

type ProfilesState = "idle" | "loading" | "error";

// Request-time quality profiles (REQUEST_ADVANCED). `profiles === null` ⇒ not
// yet loaded. Each read is a live, rate-limited Radarr/Sonarr call: "loading"
// stops Request → Cancel → Request from sending a second one, and "error"
// tells the user why there is no picker (the next open retries).
function useQualityProfiles(enabled: boolean, mediaType: MediaType) {
  const action = useAsyncAction();
  const [profiles, setProfiles] = useState<QualityProfile[] | null>(null);
  const [profilesState, setProfilesState] = useState<ProfilesState>("idle");

  async function loadProfiles() {
    if (!enabled || profiles !== null || profilesState === "loading") return;
    setProfilesState("loading");
    const res = await action.run("profiles", (signal) =>
      fetchJson(withBasePath(`/api/requests/quality-profiles?mediaType=${mediaType}`), { schema: ProfilesAnswer, signal }),
    );
    if (!res) return;
    // A non-ok answer or one without a list is a failure, not an empty picker.
    if (!res.ok) {
      setProfilesState("error");
      return;
    }
    setProfiles(res.data.qualityProfiles);
    setProfilesState("idle");
  }

  return { profiles, profilesState, loadProfiles };
}

type UsersState = "idle" | "loading" | "loaded" | "error";

// The on-behalf picker's user list: "loading" while the fetch is in flight,
// "error" when it failed — an empty select alone read as "there are no users"
// — and "loaded" once it answered, so an EMPTY list is kept rather than
// refetched on every open. Lives above the panel so closing the panel keeps it.
function useOnBehalfUsers() {
  const action = useAsyncAction();
  const [obUsers, setObUsers] = useState<OnBehalfUser[]>([]);
  const [obUsersState, setObUsersState] = useState<UsersState>("idle");

  // Fetched once: a loaded list (even an empty one) is kept; only a failed
  // read is retried on the next open.
  async function openOnBehalf() {
    if (obUsersState === "idle" || obUsersState === "error") {
      setObUsersState("loading");
      const res = await action.run("users", (signal) =>
        fetchJson(withBasePath("/api/requests/users"), { schema: UsersAnswer, signal }),
      );
      if (!res) return;
      if (!res.ok) {
        setObUsersState("error");
        return;
      }
      setObUsers(res.data.users ?? []);
      setObUsersState("loaded");
    }
  }

  return { obUsers, obUsersState, openOnBehalf };
}

// Reused in the confirm and note panels: the picker when the user can choose a
// profile, a disabled "loading" picker while the list is on its way (so Confirm
// isn't clicked believing there is no choice), and a note that the server
// default will be used when the load failed.
function ProfileSelect({
  canChooseProfile,
  profiles,
  profilesState,
  profileId,
  onChange,
  t,
}: {
  canChooseProfile: boolean;
  profiles: QualityProfile[] | null;
  profilesState: ProfilesState;
  profileId: number | "";
  onChange: (id: number | "") => void;
  t: Translate;
}) {
  if (!canChooseProfile) return null;
  if (profilesState === "error") {
    return (
      <p className="ds-mono max-w-sm" role="status" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: 0 }}>
        {t("request.profilesLoadFailed")}
      </p>
    );
  }
  if (profilesState === "loading") {
    return (
      <StyledSelect compact value="" disabled aria-label={t("request.qualityProfile")} className="max-w-sm">
        <option value="">{t("request.loadingProfiles")}</option>
      </StyledSelect>
    );
  }
  if (!profiles || profiles.length === 0) return null;
  return (
    <StyledSelect
      compact
      value={profileId}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}
      aria-label={t("request.qualityProfile")}
      className="max-w-sm"
    >
      <option value="">{t("request.serverDefaultQuality")}</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </StyledSelect>
  );
}

// The server-rendered availability and queue lines above the CTA.
function AvailabilityLines({
  plex,
  jellyfin,
  foundAvailable,
  arrPending,
  t,
}: {
  plex: boolean;
  jellyfin: boolean;
  foundAvailable: boolean;
  arrPending: boolean;
  t: Translate;
}) {
  return (
    <>
      {plex && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-plex-text)" }}
        >
          <PlayCircle style={ICON} />
          {t("request.availableOn", { server: "Plex" })}
        </div>
      )}
      {jellyfin && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-jellyfin-text)" }}
        >
          <Tv2 style={ICON} />
          {t("request.availableOn", { server: "Jellyfin" })}
        </div>
      )}
      {foundAvailable && (
        <DetailActionStatus variant="accent-soft" style={{ width: "fit-content" }}>
          <Check style={ICON} />
          {t("request.alreadyAvailable")}
        </DetailActionStatus>
      )}
      {arrPending && (
        <div
          className="flex items-center font-medium"
          style={{ gap: 6, fontSize: 13, color: "var(--ds-warning)" }}
        >
          <Clock style={ICON} />
          {t("request.queued")}
        </div>
      )}
    </>
  );
}

function ConfirmPanel({
  title,
  note,
  profileSelect,
  onConfirm,
  onCancel,
  t,
}: {
  title: string;
  note: string;
  profileSelect: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-2 w-full max-w-sm">
      <div
        className="flex items-center"
        style={{
          gap: 8,
          padding: "10px 12px",
          borderRadius: 8,
          border: "1px solid var(--ds-border)",
          background: "var(--ds-bg-2)",
        }}
      >
        <AlertCircle
          className="shrink-0"
          style={{ width: 14, height: 14, color: "var(--ds-accent-text)" }}
        />
        <p style={{ fontSize: 13, color: "var(--ds-fg)", margin: 0 }}>
          {/* Split around the title so it keeps its emphasis in any word order. */}
          <SlotText text={t("request.confirmPrompt", { title: SLOT })}>
            <span className="font-semibold">{title}</span>
          </SlotText>
        </p>
      </div>
      {/* A note typed under "Add Note" survives a failed submit so the
          user can retry without retyping it — and it rides THIS submit
          too, so the confirm step has to show it. */}
      {note.trim() && (
        <p
          className="flex items-start"
          style={{ gap: 6, fontSize: 12, color: "var(--ds-fg-muted)", margin: "0 2px" }}
        >
          <MessageSquare className="shrink-0" style={{ width: 12, height: 12, marginTop: 2 }} />
          <span className="sr-only">{t("request.noteLabel")}</span>
          <span className="min-w-0 line-clamp-3 whitespace-pre-wrap break-words">{note.trim()}</span>
        </p>
      )}
      {profileSelect}
      <div className="flex items-center gap-2">
        <DetailActionButton variant="primary" onClick={onConfirm}>
          <Check style={ICON} />
          {t("request.confirm")}
        </DetailActionButton>
        <DetailActionButton variant="ghost" onClick={onCancel}>
          <X style={ICON} />
          {t("request.cancel")}
        </DetailActionButton>
      </div>
    </div>
  );
}

function NotePanel({
  note,
  onNoteChange,
  requestLabel,
  profileSelect,
  onSubmit,
  onCancel,
  t,
}: {
  note: string;
  onNoteChange: (note: string) => void;
  requestLabel: string;
  profileSelect: ReactNode;
  onSubmit: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-2 w-full max-w-sm">
      <Textarea
        value={note}
        onChange={(e) => onNoteChange(e.target.value.slice(0, REQUEST_NOTE_MAX))}
        placeholder={t("request.notePlaceholder")}
        aria-label={t("request.noteLabel")}
        rows={3}
        autoFocus
        className="resize-none"
      />
      {/* Directly under the textarea it counts, right-aligned like a
          form hint. It used to sit below the Request/Cancel row, where
          it read as a stray label. */}
      <p
        className="ds-mono text-right"
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", margin: "-4px 2px 0 0" }}
      >
        {note.length}/{REQUEST_NOTE_MAX}
      </p>
      {profileSelect}
      <div className="flex items-center gap-2">
        <DetailActionButton variant="primary" onClick={onSubmit}>
          <Plus style={ICON} />
          {requestLabel}
        </DetailActionButton>
        <DetailActionButton variant="ghost" onClick={onCancel}>
          <X style={ICON} />
          {t("request.cancel")}
        </DetailActionButton>
      </div>
    </div>
  );
}

// "Request for user…": the user picker and its submit. Mounted only while the
// panel is open, so Cancel discards the pick and the status line with it; the
// user list itself is the parent's (useOnBehalfUsers), fetched once.
function OnBehalfPanel({
  tmdbId,
  mediaType,
  obUsers,
  obUsersState,
  onClose,
  t,
}: {
  tmdbId: number;
  mediaType: MediaType;
  obUsers: OnBehalfUser[];
  obUsersState: UsersState;
  onClose: () => void;
  t: Translate;
}) {
  const router = useRouter();
  const action = useAsyncAction();
  const [obUserId, setObUserId] = useState("");
  const [obMsg, setObMsg] = useState("");
  const [obMsgError, setObMsgError] = useState(false);
  const obSubmitting = action.busy("submit");

  async function submitOnBehalf() {
    if (!obUserId) return;
    setObMsg("");
    setObMsgError(false);
    // Never twice: a second click while the first is in flight does nothing.
    const res = await action.run(
      "submit",
      (signal) =>
        fetchJson(withBasePath("/api/requests/bulk"), {
          init: jsonInit("POST", { items: [{ tmdbId, mediaType }], onBehalfOfUserId: obUserId }),
          schema: BulkAnswer,
          signal,
          fallbackError: t("request.somethingWrong"),
        }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setObMsg(res.kind === "network" || res.kind === "timeout" ? t("request.networkError") : res.error);
      setObMsgError(true);
      return;
    }
    const data = res.data;
    const result = data.results?.[0]?.result;
    setObMsg(t(onBehalfMessage(result, data.created)));
    const failed = result !== undefined && ON_BEHALF_FAILURES.has(result);
    setObMsgError(failed);
    if (!failed) {
      // Done for that user: clear the pick so the same request isn't sent
      // again, and re-read the page (its requested / queued state).
      setObUserId("");
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full max-w-sm">
      {obUsersState === "error" ? (
        <p className="ds-mono" role="alert" style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}>
          {t("request.usersLoadFailed")}
        </p>
      ) : obUsersState === "loaded" && obUsers.length === 0 ? (
        <p className="ds-mono" role="status" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: 0 }}>
          {t("request.noEligibleUsers")}
        </p>
      ) : (
        <StyledSelect
          compact
          value={obUserId}
          onChange={(e) => setObUserId(e.target.value)}
          aria-label={t("request.selectUserLabel")}
        >
          <option value="">
            {obUsersState === "loading" ? t("request.loadingUsers") : t("request.selectUser")}
          </option>
          {obUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ?? u.email}
            </option>
          ))}
        </StyledSelect>
      )}
      <div className="flex items-center gap-2">
        <DetailActionButton
          variant="primary"
          onClick={submitOnBehalf}
          disabled={!obUserId || obSubmitting}
          busy={obSubmitting}
        >
          {obSubmitting ? (
            <Loader2 className="animate-spin" style={ICON} />
          ) : (
            <Plus style={ICON} />
          )}
          {t("request.requestForUser")}
        </DetailActionButton>
        <DetailActionButton variant="ghost" onClick={onClose}>
          <X style={ICON} />
          {t("request.cancel")}
        </DetailActionButton>
      </div>
      {obMsg && (
        <p
          className="ds-mono"
          role={obMsgError ? "alert" : "status"}
          style={{
            fontSize: 11,
            color: obMsgError ? "var(--ds-danger)" : "var(--ds-fg-subtle)",
            margin: 0,
          }}
        >
          {obMsg}
        </p>
      )}
    </div>
  );
}

// Primary HD request CTA on movie/TV detail + cards: handles the confirm/note/
// on-behalf flows and reflects availability, pending, and already-requested states.
//
// Callers key it by title (detail-actions.tsx), so a client navigation to
// another title mounts a fresh instance and no state carries across.
export function RequestButton({
  tmdbId,
  mediaType,
  title,
  plexAvailable,
  jellyfinAvailable,
  arrPending,
  requested,
  showPlex = true,
  showJellyfin = true,
  requestToken,
  canRequestOnBehalf = false,
  canChooseProfile = false,
  blacklisted = false,
  canRequest = true,
}: RequestButtonProps) {
  const { toast } = useToast();
  const t = useT();
  const router = useRouter();
  const action = useAsyncAction();
  const [state, setState] = useState<State>(requested ? "duplicate" : "idle");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  // profileId === "" ⇒ use the server default.
  const [profileId, setProfileId] = useState<number | "">("");
  const { profiles, profilesState, loadProfiles } = useQualityProfiles(canChooseProfile, mediaType);
  const { obUsers, obUsersState, openOnBehalf } = useOnBehalfUsers();
  // The route answers 200 { alreadyAvailable: true } and creates NOTHING when
  // the title is already in a library this viewer can see (or, for
  // auto-approvers, already downloaded by Radarr/Sonarr). Same handling as
  // Request4kButton: show it as available, not as a request that doesn't exist.
  const [foundAvailable, setFoundAvailable] = useState(false);
  // `requested` going true → false (the request was declined or deleted, then
  // something on the page called router.refresh) must clear a "View request"
  // this button was showing — isDone below ORs the local state in.
  const [prevRequested, setPrevRequested] = useState(!!requested);
  if (prevRequested !== !!requested) {
    setPrevRequested(!!requested);
    if (!requested && (state === "duplicate" || state === "requested")) setState("idle");
  }

  async function submitRequest() {
    setState("loading");
    setErrorMsg("");
    const note_ = note.trim();
    // Aborted on unmount; a superseded run resolves undefined and applies nothing.
    const outcome = await action.run("request", (signal) =>
      submitMediaRequest(
        {
          tmdbId,
          mediaType,
          ...(note_ ? { note: note_ } : {}),
          ...(profileId ? { qualityProfileId: profileId } : {}),
        },
        requestToken,
        t,
        signal,
      ),
    );
    if (outcome === undefined) return;
    if (outcome === "duplicate") {
      setState("duplicate");
    } else if (outcome === "alreadyAvailable") {
      setFoundAvailable(true);
      setState("idle");
      router.refresh();
    } else if (outcome === "created") {
      setState("requested");
      toast({ title: t("request.requestedToast", { title }), variant: "success" });
      // Re-render the server-side hero (availability badges, Queued state).
      router.refresh();
    } else {
      setErrorMsg(outcome.error);
      setState("error");
    }
  }

  function startOnBehalf() {
    setState("onbehalf");
    void openOnBehalf();
  }

  const isAvailable = (showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable) || foundAvailable;
  // `requested` is live — MediaCard ORs media.requestedByMe every render, and
  // a router.refresh after a watchlist auto-request flips the CTA without a
  // remount. Only the viewer's OWN request replaces the CTA. A title queued by
  // someone else (arrPending) stays requestable: the server mirrors the
  // approved status so this user is tracked for the "now available"
  // notification. The queue state is still shown by the "Queued" indicator.
  const showViewRequest = state === "requested" || state === "duplicate" || !!requested;
  const requestLabel = mediaType === "MOVIE" ? t("request.requestMovie") : t("request.requestTv");

  const profileSelect = (
    <ProfileSelect
      canChooseProfile={canChooseProfile}
      profiles={profiles}
      profilesState={profilesState}
      profileId={profileId}
      onChange={setProfileId}
      t={t}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <AvailabilityLines
        plex={!!(showPlex && plexAvailable)}
        jellyfin={!!(showJellyfin && jellyfinAvailable)}
        foundAvailable={foundAvailable}
        arrPending={!!arrPending}
        t={t}
      />

      {showViewRequest && (
        <Link
          href="/requests"
          className={DETAIL_ACTION_CLASS}
          style={{ ...detailActionStyle("accent-soft"), width: "fit-content" }}
        >
          <Check style={ICON} />
          {t("request.viewRequest")}
        </Link>
      )}

      {!isAvailable && !showViewRequest && blacklisted && (
        <DetailActionStatus variant="muted" style={{ width: "fit-content" }}>
          <Ban style={ICON} />
          {t("request.notAvailableToRequest")}
        </DetailActionStatus>
      )}

      {!isAvailable && !showViewRequest && !blacklisted && canRequest && (
        <>
          {state === "confirm" && (
            <ConfirmPanel
              title={title}
              note={note}
              profileSelect={profileSelect}
              onConfirm={submitRequest}
              onCancel={() => setState("idle")}
              t={t}
            />
          )}

          {state === "note" && (
            <NotePanel
              note={note}
              onNoteChange={setNote}
              requestLabel={requestLabel}
              profileSelect={profileSelect}
              onSubmit={submitRequest}
              onCancel={() => {
                setState("idle");
                setNote("");
              }}
              t={t}
            />
          )}

          {state === "onbehalf" && (
            <OnBehalfPanel
              tmdbId={tmdbId}
              mediaType={mediaType}
              obUsers={obUsers}
              obUsersState={obUsersState}
              onClose={() => setState("idle")}
              t={t}
            />
          )}

          {state !== "note" && state !== "confirm" && state !== "onbehalf" && (
            <div className="flex items-center gap-2 flex-wrap">
              <DetailActionButton
                variant="primary"
                onClick={() => { void loadProfiles(); setState("confirm"); }}
                disabled={state === "loading"}
                busy={state === "loading"}
              >
                {state === "loading" ? (
                  <Loader2
                    className="animate-spin"
                    style={ICON}
                  />
                ) : (
                  <Plus style={ICON} />
                )}
                {state === "loading" ? t("request.submitting") : requestLabel}
              </DetailActionButton>

              {(state === "idle" || state === "error") && (
                <>
                  <DetailActionButton
                    variant="secondary"
                    onClick={() => { void loadProfiles(); setState("note"); }}
                    title={t("request.addNoteTitle")}
                  >
                    <MessageSquare style={ICON} />
                    {t("request.addNote")}
                  </DetailActionButton>
                  {canRequestOnBehalf && (
                    <DetailActionButton
                      variant="ghost"
                      onClick={startOnBehalf}
                      title={t("request.requestForAnotherUser")}
                    >
                      <Plus style={ICON} />
                      {t("request.requestForUserEllipsis")}
                    </DetailActionButton>
                  )}
                </>
              )}
            </div>
          )}

          {state === "error" && (
            <p
              className="ds-mono max-w-sm"
              role="alert"
              style={{ fontSize: 11, color: "var(--ds-danger)", margin: 0 }}
            >
              {errorMsg}
            </p>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Download, Ban, ShieldCheck, LinkIcon, Loader2, RefreshCw, Users } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit, LONG_RUN_TIMEOUT_MS } from "@/lib/client/fetch-json";
import { v, type Schema } from "@/lib/validate";
import { mediaInstanceLabel } from "@/lib/media-instances";
import { Switch } from "@/components/ui/switch";
import { StyledSelect } from "@/components/ui/styled-select";
import { EmptyState } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { useAsyncAction } from "@/hooks/use-async-action";
import type { Translator } from "@/lib/i18n/translate";
import { MEDIA_SERVER_SOURCES, serverUserView, type MediaServerSource } from "./server-user-groups";

interface ServerUser {
  id: string;
  // The page hands the column as stored; the table lists "plex" and "jellyfin"
  // only (server-user-groups.ts), so another value is neither shown nor counted.
  source: string;
  // Multi-server support — "" is the default (and, for a single-server
  // deployment, only) instance. Distinguishes same-named users across two
  // independently-configured servers of the same provider.
  serverInstance: string;
  sourceUserId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  downloadsEnabled: boolean | null;
  isServerAdmin: boolean;
  userId: string | null;
  // An admin pinned this row's account binding by hand, so the automatic
  // linkers (the 5s poll and the hourly Jellyfin sync) leave it alone.
  manualUserLink: boolean;
  // false = departed from the media server (soft-deleted). Listed anyway when it
  // still holds play history, so that history stays attributable.
  active: boolean;
  user: { name: string | null; email: string } | null;
}

// A Summonarr account the identity can be attributed to.
interface LinkableAccount {
  id: string;
  name: string | null;
  email: string;
}

interface ServerUserTableProps {
  users: ServerUser[];
  hasJellyfin: boolean;
  autoDisableNew: boolean;
  accounts: LinkableAccount[];
  // Linking an identity hands its watch history to the chosen account, so it is
  // ADMIN-only (guardrail 34d — the route refuses a MANAGE_USERS delegate). A
  // delegate sees the binding read-only and keeps the download controls.
  canLink: boolean;
  // The "Sync users" button posts to a cron route, which admits the ADMIN role
  // only (getCronActor): a delegate is never offered a button that always fails.
  canSync: boolean;
}

// Sentinels for the picker's two non-account options. Prefixed so they can
// never collide with a real cuid.
const AUTO = "__auto__";
const NONE = "__none__";

// One message for every control's failed write. Most routes this table calls
// are ADMIN-gated (and the link picker is shown to admins only), while the Users
// page admits MANAGE_USERS delegates, so a 403 is "you need an administrator",
// translated — never the route's raw English `{ error: "Forbidden" }` echoed
// into a French or Spanish UI. A 401 reads the same: the auth wrappers answer it
// for a missing session, and the cron routes (getCronActor) for any non-ADMIN.
function failureMessage(status: number, serverError: string | undefined, t: Translator): string {
  if (status === 401 || status === 403) return t("adminManage.serverUsers.requiresAdmin");
  return serverError ?? t("adminManage.notif.failed", { status });
}

type WriteResult<T> = { ok: true; data: T | null } | { ok: false; error: string };

// The one write path for every control on this table. Each caller names the
// shape it reads from a 2xx (`schema`); a 2xx that isn't that JSON — a proxy's
// page, a changed route — is a failure, never a silent success. A non-2xx
// answer goes through failureMessage — or `genericError` for a route whose own
// errors are untranslated English — and no answer at all (a network failure, a
// proxy's own 5xx page) is the translated network error. The default 30 s
// bound applies unless the caller names a longer one (`timeoutMs`: a route
// that walks every user of every server); the caller owns refresh and any
// rollback.
async function sendWrite<T>(
  url: string,
  init: { method: "PATCH" | "POST"; body?: unknown },
  t: Translator,
  schema: Schema<T>,
  signal: AbortSignal,
  genericError?: string,
  timeoutMs?: number,
): Promise<WriteResult<T>> {
  const res = await fetchJson(withBasePath(url), {
    init: init.body === undefined ? { method: init.method } : jsonInit(init.method, init.body),
    schema: v.nullable(schema),
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (res.ok) return { ok: true, data: res.data };
  if (res.kind === "http") {
    const authFailure = res.status === 401 || res.status === 403;
    return { ok: false, error: genericError && !authFailure ? genericError : failureMessage(res.status, res.error || undefined, t) };
  }
  if (res.kind === "invalid") return { ok: false, error: genericError ?? failureMessage(res.status, undefined, t) };
  return { ok: false, error: t("adminManage.serverUsers.networkError") };
}

// Every control's write state in one place: per-key busy (a second write on a
// key that is running is skipped, unmount aborts what is in flight) and the
// last failure. `send` resolves undefined when the run was dropped, otherwise
// the write's result; a failure is already in `error`.
function useServerUserWrite() {
  const t = useT();
  const action = useAsyncAction();
  const [error, setError] = useState<string | null>(null);

  async function send<T>(
    url: string,
    init: { method: "PATCH" | "POST"; body?: unknown },
    schema: Schema<T>,
    opts?: { key?: string; genericError?: string; timeoutMs?: number },
  ): Promise<WriteResult<T> | undefined> {
    const result = await action.run(
      opts?.key ?? "write",
      (signal) => {
        setError(null);
        return sendWrite(url, init, t, schema, signal, opts?.genericError, opts?.timeoutMs);
      },
      { ifBusy: "skip" },
    );
    if (result && !result.ok) setError(result.error);
    return result;
  }

  return { send, error, busy: action.busy, anyBusy: action.anyBusy };
}

// What each write's 2xx carries that a control reads.
const NO_ANSWER = v.unknown();
const POLICY_ANSWER = v.object({ pushed: v.optional(v.boolean()), warning: v.optional(v.string()) });
const POLICY_SYNC_ANSWER = v.object({ ok: v.optional(v.boolean()), skipped: v.optional(v.boolean()), errors: v.optional(v.number()) });
const BULK_ANSWER = v.object({ pushed: v.optional(v.number()), errors: v.optional(v.number()) });

// DS brand chip recipes (solid brand fill, black text) — the same classes the
// Users table above uses, so Plex/Jellyfin read as one family down the page.
const sourceStyles: Record<MediaServerSource, string> = {
  plex:     "ds-chip-plex",
  jellyfin: "ds-chip-jellyfin",
};

// Fixed (non-theme) fills, so the initials colour is fixed too: black on the
// light yellow-600 (white there is ~2.9:1), white on the dark purple-700.
const avatarColors: Record<MediaServerSource, string> = {
  plex:     "bg-yellow-600",
  jellyfin: "bg-purple-700",
};
const avatarText: Record<MediaServerSource, string> = {
  plex:     "text-black",
  jellyfin: "text-white",
};

// Manual account binding for one media-server identity. Automatic resolution
// (provider subject id, then email) covers the common case; this is the escape
// hatch for an identity that matched nothing or matched the WRONG account.
// Choosing an account or "Not linked" pins the row so the 5s poll and the hourly
// sync stop re-deriving it; "Automatic" hands it back.
function LinkPicker({
  row,
  accounts,
}: {
  row: ServerUser;
  accounts: LinkableAccount[];
}) {
  const t = useT();
  const router = useRouter();
  const write = useServerUserWrite();
  const { error } = write;
  const loading = write.anyBusy;

  const value = !row.manualUserLink ? AUTO : (row.userId ?? NONE);

  async function change(next: string) {
    const result = await write.send(`/api/admin/server-users/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: next === AUTO ? { autoLink: true } : { userId: next === NONE ? null : next },
    }, NO_ANSWER);
    if (result?.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {loading ? (
          <Loader2 className="w-3 h-3 animate-spin text-zinc-500 shrink-0" />
        ) : (
          <LinkIcon className={`w-3 h-3 shrink-0 ${row.userId ? "text-zinc-400" : "text-zinc-600"}`} />
        )}
        {/* The house select (compact = Input's 32px) — text-base below md so
            iOS Safari doesn't zoom on focus; 12px on desktop keeps the row dense. */}
        <StyledSelect
          compact
          value={value}
          disabled={loading}
          aria-label={t("adminManage.serverUsers.linkAria", { name: row.username })}
          onChange={(e) => change(e.target.value)}
          className="max-w-[170px] truncate md:text-xs"
        >
          <option value={AUTO}>
            {row.user
              ? t("adminManage.serverUsers.automaticMatched", { name: row.user.name ?? row.user.email })
              : t("adminManage.serverUsers.automaticUnmatched")}
          </option>
          <option value={NONE}>{t("adminManage.serverUsers.notLinked")}</option>
          {/* A pinned account missing from the list (deactivated, or past the
              list's cap) must still show as the selection, not fall back to
              the first option. */}
          {row.userId && row.user && !accounts.some((a) => a.id === row.userId) && (
            <option key={row.userId} value={row.userId}>
              {row.user.name ?? row.user.email}
            </option>
          )}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ?? a.email}
            </option>
          ))}
        </StyledSelect>
      </div>
      {row.manualUserLink && !error && (
        <span className="text-[10px] text-amber-400">{t("adminManage.serverUsers.pinned")}</span>
      )}
      {error && <span role="alert" className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

// The binding as a delegate sees it: the same wording as the picker's selected
// option, without the picker (guardrail 34d — linking is ADMIN-only).
function LinkedAccountLabel({ row }: { row: ServerUser }) {
  const t = useT();
  const label = !row.manualUserLink
    ? row.user
      ? t("adminManage.serverUsers.automaticMatched", { name: row.user.name ?? row.user.email })
      : t("adminManage.serverUsers.automaticUnmatched")
    : row.user
      ? (row.user.name ?? row.user.email)
      : t("adminManage.serverUsers.notLinked");
  return (
    <div className="flex flex-col gap-1" title={t("adminManage.serverUsers.requiresAdmin")}>
      <div className="flex items-center gap-1.5 min-w-0">
        <LinkIcon className={`w-3 h-3 shrink-0 ${row.userId ? "text-zinc-400" : "text-zinc-600"}`} />
        <span className="max-w-[170px] truncate text-xs text-zinc-300">{label}</span>
      </div>
      {row.manualUserLink && (
        <span className="text-[10px] text-amber-400">{t("adminManage.serverUsers.pinned")}</span>
      )}
    </div>
  );
}

function DownloadToggle({
  userId,
  username,
  enabled,
  disabled: isDisabled,
}: {
  userId: string;
  username: string;
  enabled: boolean | null;
  disabled: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const write = useServerUserWrite();
  const { error } = write;
  const loading = write.anyBusy;
  // The admin's own click, shown until the server value moves: it applies only
  // while the prop is still the one it was made over, so a bulk "Disable all"
  // (or another admin's change) arriving through router.refresh() wins, and a
  // failed write drops it.
  const [override, setOverride] = useState<{ over: boolean | null; value: boolean } | null>(null);
  // Dropped the moment the prop moves, so it can't re-apply when a later change
  // brings the prop back to the value it was made over.
  if (override && override.over !== enabled) setOverride(null);
  const optimistic = override && override.over === enabled ? override.value : enabled;
  // A write the route saved but could not push to the media server (amber —
  // `pushed: false`). The hourly reconcile only re-pushes drift in the DISABLE
  // direction, so a failed enable-push never self-heals; a green switch over a
  // policy that is not in effect is exactly what the route's warning exists to
  // prevent.
  const [warning, setWarning] = useState<string | null>(null);

  async function toggle() {
    // null means not-yet-synced — first click enables downloads
    const next = !(optimistic ?? false);
    setOverride({ over: enabled, value: next });
    setWarning(null);
    const result = await write.send(
      `/api/admin/server-users/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: { downloadsEnabled: next } },
      POLICY_ANSWER,
    );
    if (!result) return;
    if (!result.ok) {
      // Refused or never reached the server — roll back the optimistic state.
      setOverride(null);
      return;
    }
    if (result.data?.pushed === false) {
      setWarning(result.data.warning ?? t("adminManage.serverUsers.savedNotPushed"));
    }
    router.refresh();
  }

  if (isDisabled) {
    return (
      <Badge className="border-zinc-700 bg-zinc-800 text-zinc-500 text-[10px]">
        {t("adminManage.serverUsers.admin")}
      </Badge>
    );
  }

  // null = not yet synced from server — show as indeterminate, not enabled
  if (optimistic === null) {
    return (
      <span className="text-[11px] text-zinc-500 italic">{t("adminManage.serverUsers.notSynced")}</span>
    );
  }

  const on = optimistic;

  return (
    <div className="flex flex-col items-end gap-1">
      <Switch
        variant="success"
        checked={on}
        aria-label={t("adminManage.serverUsers.toggleDownloadsFor", { name: username })}
        disabled={loading}
        loading={loading}
        onCheckedChange={toggle}
        title={on ? t("adminManage.serverUsers.downloadsOnTitle") : t("adminManage.serverUsers.downloadsOffTitle")}
      />
      {error && (
        <span role="alert" className="max-w-[180px] text-right text-[10px] text-red-400">{error}</span>
      )}
      {!error && warning && (
        <span role="status" className="max-w-[180px] text-right text-[10px] text-amber-400">{warning}</span>
      )}
    </div>
  );
}

function SyncUsersButton() {
  const t = useT();
  const router = useRouter();
  const write = useServerUserWrite();
  const { error } = write;
  const loading = write.anyBusy;
  // A 200 that is not a clean run: the advisory lock was held (`skipped`), or
  // some policies failed (`ok: false` — the route keeps 200 on a partial
  // failure and marks the run degraded). Its English `error` is never shown.
  const [notice, setNotice] = useState<string | null>(null);

  async function sync() {
    setNotice(null);
    const result = await write.send(
      "/api/cron/sync-download-policies",
      { method: "POST" },
      POLICY_SYNC_ANSWER,
      // The run reads every user of every configured server, one by one.
      { genericError: t("adminManage.serverUsers.syncFailed"), timeoutMs: LONG_RUN_TIMEOUT_MS },
    );
    if (!result?.ok) return;
    if (result.data?.skipped === true) {
      setNotice(t("adminManage.serverUsers.syncSkipped"));
      return;
    }
    if (result.data?.ok === false) {
      setNotice(t("adminManage.serverUsers.syncErrors", { count: result.data.errors ?? 0 }));
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={sync}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100 transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        {loading ? t("adminManage.serverUsers.syncing") : t("adminManage.serverUsers.sync")}
      </button>
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      {!error && notice && <span role="status" className="text-xs text-amber-400">{notice}</span>}
    </div>
  );
}

type BulkKind = "disable" | "enable";

// One entry per bulk write, read by both the toolbar and its confirm.
const BULK_KINDS: Record<BulkKind, {
  downloadsEnabled: boolean;
  labelKey: string;
  confirmKey: string;
  tone: string;
  icon: typeof Ban;
}> = {
  disable: {
    downloadsEnabled: false,
    labelKey: "adminManage.serverUsers.bulk.disableAll",
    confirmKey: "adminManage.serverUsers.bulk.confirmDisable",
    tone: "bg-red-500/10 text-red-400 hover:bg-red-500/20",
    icon: Ban,
  },
  enable: {
    downloadsEnabled: true,
    labelKey: "adminManage.serverUsers.bulk.enableAll",
    confirmKey: "adminManage.serverUsers.bulk.confirmEnable",
    tone: "bg-green-500/10 text-green-400 hover:bg-green-500/20",
    icon: Download,
  },
};

function BulkBar({
  source,
  label,
}: {
  source: "jellyfin";
  label: string;
}) {
  const t = useT();
  const router = useRouter();
  const write = useServerUserWrite();
  const { error } = write;
  const loading: BulkKind | null = write.busy("bulk:disable") ? "disable" : write.busy("bulk:enable") ? "enable" : null;
  // The route saves every row and answers 200 even when some users' policy
  // could not be pushed to Jellyfin (`errors`). A failed enable-push never
  // self-heals (the hourly reconcile re-pushes disables only), so say so.
  const [warning, setWarning] = useState<string | null>(null);
  // A bulk write overwrites every per-user setting and can't be undone (the
  // opposite button restores a uniform state, not the previous mix), so each
  // one asks first — the same inline confirm as the library Resync button.
  const [confirming, setConfirming] = useState<BulkKind | null>(null);
  // The confirm replaces the button that opened it: focus moves into it, and
  // back to that button on Cancel or (if still lost) when the write ends.
  const focus = useFocusReturn();

  async function bulk(kind: BulkKind) {
    setConfirming(null);
    setWarning(null);
    const result = await write.send(
      "/api/admin/server-users/bulk",
      { method: "POST", body: { source, downloadsEnabled: BULK_KINDS[kind].downloadsEnabled } },
      BULK_ANSWER,
      // One policy push per Jellyfin user: minutes on a large server.
      { key: `bulk:${kind}`, timeoutMs: LONG_RUN_TIMEOUT_MS },
    );
    focus.returnToIfLost(kind);
    if (!result?.ok) return;
    const notPushed = result.data?.errors ?? 0;
    if (notPushed > 0) setWarning(t("adminManage.serverUsers.bulk.notPushed", { count: notPushed }));
    router.refresh();
  }

  if (confirming) {
    return (
      <BulkConfirm
        kind={confirming}
        label={label}
        onConfirm={() => void bulk(confirming)}
        onCancel={() => {
          focus.returnTo(confirming);
          setConfirming(null);
        }}
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">{label}:</span>
      {(["disable", "enable"] as const).map((kind) => {
        const { icon: Icon, labelKey, tone } = BULK_KINDS[kind];
        return (
          <button
            key={kind}
            ref={focus.refFor(kind)}
            onClick={() => setConfirming(kind)}
            disabled={loading !== null}
            className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-[var(--ds-border)] ${tone} transition-colors disabled:opacity-50`}
          >
            {loading === kind ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
            {t(labelKey)}
          </button>
        );
      })}
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
      {!error && warning && <span role="status" className="text-xs text-amber-400">{warning}</span>}
    </div>
  );
}

// The question a bulk write asks first. Focus starts on Cancel — the answer
// that changes nothing — and the group is labelled by the question, so a
// screen reader announces it.
function BulkConfirm({
  kind,
  label,
  onConfirm,
  onCancel,
}: {
  kind: BulkKind;
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const promptId = useId();
  const { confirmKey, labelKey, tone } = BULK_KINDS[kind];
  return (
    <div role="group" aria-labelledby={promptId} className="flex flex-wrap items-center gap-2">
      <span id={promptId} className="text-xs text-zinc-300">
        {t(confirmKey, { label })}
      </span>
      <button
        onClick={onConfirm}
        className={`px-2 py-0.5 text-xs rounded border transition-colors border-[var(--ds-border)] ${tone}`}
      >
        {t(labelKey)}
      </button>
      <button
        autoFocus
        onClick={onCancel}
        className="px-2 py-0.5 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors"
      >
        {t("adminManage.common.cancel")}
      </button>
    </div>
  );
}

function AutoDisableToggle({ initial }: { initial: boolean }) {
  const t = useT();
  const router = useRouter();
  const write = useServerUserWrite();
  const { error } = write;
  const loading = write.anyBusy;
  // Follow the server value, as DownloadToggle does: the admin's own click
  // applies only while the prop is the one it was made over, so another admin's
  // change (or this one's, re-read) shows without a full navigation.
  const [override, setOverride] = useState<{ over: boolean; value: boolean } | null>(null);
  if (override && override.over !== initial) setOverride(null);
  const on = override && override.over === initial ? override.value : initial;

  async function toggle() {
    const next = !on;
    setOverride({ over: initial, value: next });
    const result = await write.send("/api/admin/server-users", { method: "PATCH", body: { autoDisableNew: next } }, NO_ANSWER);
    if (!result) return;
    // Refused or never reached the server — roll back the optimistic state.
    if (!result.ok) setOverride(null);
    else router.refresh();
  }

  return (
    <div className="flex items-center gap-2.5 py-2 px-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200">{t("adminManage.serverUsers.autoDisable")}</p>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          {t("adminManage.serverUsers.autoDisableHint")}
        </p>
        {error && <p role="alert" className="text-[11px] text-red-400 mt-0.5">{error}</p>}
      </div>
      <Switch
        checked={on}
        aria-label={t("adminManage.serverUsers.autoDisable")}
        disabled={loading}
        loading={loading}
        onCheckedChange={toggle}
      />
    </div>
  );
}

export function ServerUserTable({ users, hasJellyfin, autoDisableNew, accounts, canLink, canSync }: ServerUserTableProps) {
  const t = useT();
  const [search, setSearch] = useState("");
  // The account control renders in ONE place per row: the mobile stack below
  // md, the Linked-account column from md up. Mounting it in both kept two
  // copies of every account <option> per row and split their error state.
  // null (SSR and hydration) renders the desktop column, like the server did.
  const mdUp = useMediaQuery("(min-width: 48rem)");
  const view = useMemo(() => serverUserView(users, search), [users, search]);

  if (view.total === 0) {
    return (
      <div className="flex flex-col gap-3 py-2">
        {hasJellyfin && <AutoDisableToggle initial={autoDisableNew} />}
        <EmptyState
          icon={Users}
          title={t("adminManage.serverUsers.empty")}
          action={canSync ? <SyncUsersButton /> : undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasJellyfin && <AutoDisableToggle initial={autoDisableNew} />}

      {/* Toolbar: bulk controls + sync button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          {hasJellyfin && <BulkBar source="jellyfin" label="Jellyfin" />}
        </div>
        {canSync && <SyncUsersButton />}
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder={t("adminManage.serverUsers.filterPlaceholder")}
        aria-label={t("adminManage.serverUsers.filter")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full sm:w-72 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />

      <div className="rounded-xl border border-zinc-800 overflow-x-auto">
        <table className="w-full text-sm">
          <ServerUserTableHead />
          <tbody className="bg-zinc-900/30">
            {MEDIA_SERVER_SOURCES.flatMap((source) =>
              view.groups[source].map((u) => (
                <ServerUserRow key={u.id} u={u} source={source} mdUp={mdUp} canLink={canLink} accounts={accounts} />
              )),
            )}
            {view.shown === 0 && (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-center text-sm text-zinc-500">
                  {t("adminManage.serverUsers.noMatch", { query: search.trim() })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Both counts use the same search-filtered set, so they always agree. */}
      <p className="text-[11px] text-zinc-500">
        {search.trim()
          ? t("adminManage.serverUsers.countOf", { count: view.shown, total: view.total })
          : t("adminManage.serverUsers.count", { count: view.shown })}
        {hasJellyfin && (
          <>
            {" · "}
            {t("adminManage.serverUsers.disabledCount", { count: view.disabledJellyfin })}
          </>
        )}
      </p>
    </div>
  );
}

function ServerUserTableHead() {
  const t = useT();
  const th = "text-[11px] font-semibold uppercase tracking-wider text-zinc-500";
  return (
    <thead>
      <tr className="border-b border-zinc-800 bg-zinc-900/60">
        <th scope="col" className={`py-2 pl-4 pr-3 text-left ${th}`}>{t("adminManage.serverUsers.col.user")}</th>
        <th scope="col" className={`py-2 px-3 text-left ${th} hidden sm:table-cell`}>{t("adminManage.serverUsers.col.source")}</th>
        <th scope="col" className={`py-2 px-3 text-left ${th} hidden md:table-cell`}>{t("adminManage.serverUsers.col.linked")}</th>
        <th scope="col" className={`py-2 pl-3 pr-4 text-right ${th}`}>{t("adminManage.serverUsers.col.downloads")}</th>
      </tr>
    </thead>
  );
}

function ServerUserRow({
  u,
  source,
  mdUp,
  canLink,
  accounts,
}: {
  u: ServerUser;
  source: MediaServerSource;
  /** useMediaQuery's answer: null until hydrated, which renders the desktop column. */
  mdUp: boolean | null;
  canLink: boolean;
  accounts: LinkableAccount[];
}) {
  const t = useT();
  const initials = u.username.slice(0, 2).toUpperCase();
  // Guardrail 34d: the picker for an admin, the binding read-only otherwise.
  const linkControl = canLink ? <LinkPicker row={u} accounts={accounts} /> : <LinkedAccountLabel row={u} />;

  return (
    <tr className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/20 transition-colors">
      {/* Avatar + name */}
      {/* max-w-0 + w-full is what lets `truncate` below engage in an
          auto-layout table: without a width bound a long email widened
          the table past its wrapper and clipped the Downloads column. */}
      <td className="py-2.5 pl-4 pr-3 max-w-0 w-full">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Plex/Jellyfin avatar URL comes from an arbitrary upstream host (can't be
              added to next/image remotePatterns up front); the shared Avatar falls back
              to initials when the thumb is missing or fails to load. */}
          <Avatar className={`size-7 shrink-0 ${avatarColors[source]}`}>
            {u.thumbUrl ? <AvatarImage src={u.thumbUrl} alt={u.username} /> : null}
            <AvatarFallback className={`bg-transparent text-[10px] font-bold ${avatarText[source]}`}>
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-zinc-100 truncate">{u.username}</span>
              {u.isServerAdmin && (
                <ShieldCheck className="w-3 h-3 text-indigo-400 shrink-0" aria-label={t("adminManage.serverUsers.serverAdmin")} />
              )}
              {!u.active && (
                <Badge
                  className="border-zinc-700 bg-zinc-800 text-zinc-400 text-[10px] shrink-0"
                  title={t("adminManage.serverUsers.departedTitle")}
                >
                  {t("adminManage.serverUsers.departed")}
                </Badge>
              )}
            </div>
            {u.email && (
              <span className="text-[11px] text-zinc-500 truncate block">{u.email}</span>
            )}
            {/* The Source and Linked-account columns are hidden on narrow
                screens; stack them here so a phone can still tell Plex from
                Jellyfin and fix a row's attribution. */}
            <div className="md:hidden mt-1 flex flex-wrap items-center gap-1.5">
              <Badge className={`sm:hidden text-[10px] ${sourceStyles[source]}`}>
                {mediaInstanceLabel(source, u.serverInstance)}
              </Badge>
              {mdUp === false && linkControl}
            </div>
          </div>
        </div>
      </td>

      {/* Source badge — includes the instance slug for a named server
          (e.g. "jellyfin:remote") so a same-named user on two servers of
          the same provider is distinguishable; unchanged ("jellyfin") for
          the default/only instance in a single-server deployment. */}
      <td className="py-2.5 px-3 hidden sm:table-cell">
        <Badge className={`text-[10px] ${sourceStyles[source]}`}>
          {mediaInstanceLabel(source, u.serverInstance)}
        </Badge>
      </td>

      {/* Linked Summonarr account — whose watch history this identity feeds */}
      <td className="py-2.5 px-3 hidden md:table-cell">
        {mdUp !== false && linkControl}
      </td>

      {/* Downloads toggle (Jellyfin only — Plex sharing API does not support
          remote toggle). A departed row (guardrail 28) gets the same
          placeholder as Plex: the route 404s its policy branch because
          there is no server-side account left to push a policy to, so a
          live switch there could only ever snap back. */}
      <td className="py-2.5 pl-3 pr-4 text-right">
        {source === "jellyfin" && u.active ? (
          <DownloadToggle
            userId={u.id}
            username={u.username}
            enabled={u.downloadsEnabled}
            disabled={u.isServerAdmin}
          />
        ) : (
          <span className="text-[11px] text-zinc-500">—</span>
        )}
      </td>
    </tr>
  );
}

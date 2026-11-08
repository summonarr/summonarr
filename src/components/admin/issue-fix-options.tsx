"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Check, AlertTriangle } from "@/components/icons";
import type { ReplaceFollowUp } from "@/lib/issue-replace";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { queueFormatters } from "@/components/admin/queue-format";
import { requestPageRefresh } from "@/lib/client/refresh-hold";
import { apiErrorText } from "@/lib/client/api-error";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { runReplaceFileJob } from "@/lib/client/replace-file-job";
import { useAsyncAction } from "@/hooks/use-async-action";
import { v } from "@/lib/validate";
import { defaultFileSelection, fixAdvice, type FixAdvice } from "@/lib/issue-fix";
import { arrServiceName } from "@/lib/arr-service-name";
import { fileListingOf, replaceResultOf, type FileListing, type ReplaceResult } from "./issue-fix-answers";
import {
  CONFIRM_NAMES,
  FixChoices,
  OnDiskSection,
  ReplaceConfirm,
  ReplaceResultSummary,
  confirmFileName,
  type FixChoiceKind,
} from "./issue-fix-options-parts";

/** The Fix file window's one write at a time: the delete, the search or the grab. */
export type FixFileAction = "replace" | "search" | "grab";

// PATCH /api/issues/[id] { refetch } answers the issue and an `arrError` — set
// when Radarr/Sonarr refused the search (a 200: the issue itself is fine).
const RefetchAnswer = v.object({ arrError: v.optional(v.nullable(v.string())) });

// The refetch only asks the arr to queue a search; it answers in seconds.
const SEARCH_TIMEOUT_MS = 60_000;

const ADVICE_KEY: Record<FixAdvice, string> = {
  broken: "adminQueue.issueActions.adviceBroken",
  upgrade: "adminQueue.issueActions.adviceUpgrade",
  nothing: "adminQueue.issueActions.adviceNothing",
  unknown: "adminQueue.issueActions.adviceUnknown",
};

// The Fix file window's options view for ONE instance: what is on disk
// (ADMIN), the advice, the choices and the delete's confirm. The window mounts
// it with key={instance}, so an instance switch starts every piece of state
// here from its initial value and nothing is reset by hand. It stays mounted
// while the release list shows (rendering nothing), so Back finds the files,
// the selection and a result as they were: the files are read once per
// instance. The write in flight (`action`) and the delete's follow-up
// (`blockRelease`) are the window's, so the header can lock and a switch
// keeps the box as the admin left it. The pieces it draws are in
// issue-fix-options-parts.tsx; the answers it reads are checked in
// issue-fix-answers.ts.
export function FixFileOptions({
  issueId,
  mediaType,
  isAdmin,
  canPickRelease,
  instance,
  shown,
  action,
  onAction,
  blockRelease,
  onBlockReleaseChange,
  onPickRelease,
  onClose,
}: {
  issueId: string;
  mediaType: string;
  isAdmin: boolean;
  canPickRelease: boolean;
  /** The instance this view reads and writes; the window remounts the view for another. */
  instance: string;
  /** False while the release list shows. */
  shown: boolean;
  action: FixFileAction | null;
  onAction: (action: FixFileAction | null) => void;
  blockRelease: boolean;
  onBlockReleaseChange: (block: boolean) => void;
  onPickRelease: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const serviceName = arrServiceName(mediaType);
  const isSeries = mediaType !== "MOVIE";

  const [actionError, setActionError] = useState<string | null>(null);

  // What's on disk (ADMIN only).
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listLoading, setListLoading] = useState(isAdmin);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ReplaceResult | null>(null);
  const [searched, setSearched] = useState(false);
  // Only the newest read may write state: an older answer (a re-run effect, a
  // Retry, the reload after a failed delete) must not land on a newer one.
  const reqRef = useRef(0);
  // The search's request: aborted (and its answer dropped) once this view is gone.
  const writes = useAsyncAction();

  // The delete's polling stops once the window (or this instance's view) is gone.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // The delete's confirm takes focus as it opens (ReplaceConfirm); a Cancel
  // hands it back to the Delete choice that opened it.
  const deleteRef = useRef<HTMLButtonElement>(null);
  const refocusDelete = useRef(false);
  useEffect(() => {
    if (!confirming && refocusDelete.current) {
      refocusDelete.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);

  const load = useCallback(async (target: string) => {
    const reqId = ++reqRef.current;
    setListLoading(true);
    setListError(null);
    const res = await fetchJson(withBasePath(`/api/issues/${issueId}/files?instance=${encodeURIComponent(target)}`), {
      fallbackError: t("adminQueue.issueActions.replaceFileLoadFailed"),
    });
    if (reqId !== reqRef.current) return;
    setListLoading(false);
    const read = res.ok ? fileListingOf(res.data) : null;
    if (!read) {
      setListing(null);
      // The route's own reason (a 404 for an instance that doesn't hold the
      // title); no answer at all is the network line; a listing of another
      // shape is "couldn't read the files".
      setListError(res.ok ? t("adminQueue.issueActions.replaceFileLoadFailed")
        : res.kind === "network" || res.kind === "timeout" ? t("shared.thread.networkError") : res.error);
      return;
    }
    const files = read.files;
    setListing(read);
    // Keep what is still listed; with nothing kept, tick the only file.
    setSelected((prev) => {
      const kept = [...prev].filter((id) => files.some((f) => f.id === id));
      return new Set(kept.length > 0 ? kept : defaultFileSelection(files));
    });
  }, [issueId, t]);

  // Read when this instance's view mounts — ADMIN only.
  useEffect(() => {
    if (isAdmin) void load(instance);
  }, [isAdmin, load, instance]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  function pickRelease() {
    setActionError(null);
    onPickRelease();
  }

  async function searchNow() {
    if (writes.busy("search")) return;
    onAction("search");
    setActionError(null);
    const res = await writes.run("search", (signal) =>
      fetchJson(withBasePath(`/api/issues/${issueId}`), {
        // The instance the window names — an issue about the 4K copy must
        // search the 4K instance, not the default. "" when there is one instance.
        init: jsonInit("PATCH", { refetch: true, instance }),
        schema: RefetchAnswer,
        signal,
        timeoutMs: SEARCH_TIMEOUT_MS,
      }), { ifBusy: "skip" });
    onAction(null);
    // The window closed meanwhile: nothing here to tell.
    if (!res) return;
    // Check res.ok FIRST. The server reports two kinds of failure: a normal
    // error status (the integration switched off 404, an instance that isn't a
    // configured one 422, 503, 401/403, 400, 409, 413, 429) with no `arrError`
    // field, and a Radarr/Sonarr failure sent as HTTP 200 WITH `arrError`.
    // Looking only for `arrError` would report the first kind as sent. A 2xx
    // whose body can't be read was still sent.
    if (!res.ok && res.kind !== "invalid") {
      setActionError(res.kind === "http"
        ? apiErrorText(res.body, t("adminQueue.issueActions.searchFailed", { status: res.status }))
        : t("shared.thread.networkError"));
      return;
    }
    const data = res.ok ? res.data : {};
    if (data.arrError) {
      setActionError(data.arrError);
    } else {
      setSearched(true);
      // Once the window closes — the issue may leave this tab's list.
      requestPageRefresh(() => router.refresh());
    }
  }

  async function replace(then: ReplaceFollowUp) {
    onAction("replace");
    setActionError(null);
    let reload = false;
    try {
      // A background job, polled (the guardrail-37a pattern): a long series'
      // marks outlast a reverse proxy's hold, and a 502 there read as a failed
      // replace while the files were already gone.
      const answer = await runReplaceFileJob(
        fetch,
        withBasePath(`/api/issues/${issueId}/files`),
        { instance, fileIds: [...selected], then },
        { isAlive: () => aliveRef.current },
      );
      if (answer === null) return;
      if (answer.status === 0) {
        // No answer (the polls failed or ran out): the replace may still be
        // running, and files may already be gone — never "try again" on a
        // destructive job. Show what's left.
        setActionError(t("adminQueue.issueActions.replaceFileNoAnswer"));
        reload = true;
      } else {
        // A 502 can still carry what WAS done (files deleted before the search
        // failed, or a delete that stopped part-way) — show it either way.
        const done = replaceResultOf(answer.data);
        if (done) {
          setResult(done);
          setSelected(new Set());
          // Once the window closes — the issue may leave this tab's list.
          requestPageRefresh(() => router.refresh());
        }
        // A refusal, a delete that stopped part-way (its error names how many
        // went), or an answer that deleted nothing: say so, and show what's left.
        if (answer.status < 200 || answer.status >= 300 || !done) {
          setActionError(apiErrorText(answer.data, t("adminQueue.issueActions.replaceFileFailed")));
          reload = true;
        }
      }
    } catch {
      // The POST itself failed on the network — it may have reached the
      // server first, so this is the same "no answer", not a network retry.
      setActionError(t("adminQueue.issueActions.replaceFileNoAnswer"));
      reload = true;
    } finally {
      onAction(null);
      setConfirming(false);
    }
    if (reload) {
      void load(instance);
    }
  }

  // Hidden behind the release list: the state above stays, nothing renders.
  if (!shown) return null;

  const files = listing?.files ?? [];
  const advice = fixAdvice(isAdmin && listing !== null ? files : null);
  const done = (result !== null && actionError === null) || searched;
  const working = action !== null;
  const chosen = files.filter((f) => selected.has(f.id));
  const chosenSize = chosen.reduce((n, f) => n + f.size, 0);

  // The choices, best first for what is on disk. Delete needs listed files.
  const canDelete = isAdmin && files.length > 0;
  const order: FixChoiceKind[] =
    advice === "broken" ? ["delete", "pick", "search"]
    : advice === "upgrade" ? ["search", "delete", "pick"]
    : ["search", "pick", "delete"];
  const choices = order.filter((c) => (c === "delete" ? canDelete : c === "pick" ? canPickRelease : true));

  return (
    <>
      <DialogContent className="grid gap-4 p-4 sm:p-6">
        {/* Hidden once the delete went through: the list would show files no longer on disk. */}
        {isAdmin && !(result !== null && actionError === null) && (
          <OnDiskSection
            listLoading={listLoading}
            listError={listError}
            listing={listing}
            isSeries={isSeries}
            serviceName={serviceName}
            done={done}
            selected={selected}
            working={working}
            onRetry={() => void load(instance)}
            onSelectAll={(all) => { setSelected(all ? new Set(files.map((f) => f.id)) : new Set()); setConfirming(false); }}
            onToggle={toggle}
            formatSize={fmt.size}
          />
        )}

        {!done && !listLoading && (
          <p className="m-0 text-sm text-zinc-300">
            {isAdmin
              ? t(ADVICE_KEY[advice], { service: serviceName })
              : t("adminQueue.issueActions.adviceIssueAdmin", { service: serviceName })}
          </p>
        )}

        {result && <ReplaceResultSummary result={result} serviceName={serviceName} />}

        {searched && (
          <span className="flex items-center gap-1.5 text-sm text-green-400">
            <Check className="h-4 w-4 shrink-0" />
            {t("adminQueue.issueActions.searchSent", { service: serviceName })}
          </span>
        )}

        {actionError && (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-xs text-red-400">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{actionError}</span>
          </p>
        )}

        {!done && !confirming && !listLoading && (
          <FixChoices
            choices={choices}
            advice={advice}
            serviceName={serviceName}
            selectedCount={selected.size}
            working={working}
            listLoading={listLoading}
            searching={action === "search"}
            blockRelease={blockRelease}
            deleteRef={deleteRef}
            onDelete={() => setConfirming(true)}
            onBlockReleaseChange={(block) => { onBlockReleaseChange(block); setConfirming(false); }}
            onSearch={() => void searchNow()}
            onPick={pickRelease}
          />
        )}
      </DialogContent>

      {confirming && chosen.length > 0 && !done && (
        <ReplaceConfirm
          names={chosen.slice(0, CONFIRM_NAMES).map((f) => ({ id: f.id, name: confirmFileName(f, isSeries) }))}
          more={Math.max(0, chosen.length - CONFIRM_NAMES)}
          size={fmt.size(chosenSize)}
          blockRelease={blockRelease}
          serviceName={serviceName}
          working={working}
          replacing={action === "replace"}
          onCancel={() => { refocusDelete.current = true; setConfirming(false); }}
          onConfirm={() => void replace(blockRelease ? "markFailed" : "search")}
        />
      )}
      {done && (
        <div className="flex justify-end px-4 py-4 sm:px-6 border-t border-zinc-700 bg-zinc-900 flex-shrink-0">
          <Button size="sm" onClick={onClose}>{t("adminQueue.common.close")}</Button>
        </div>
      )}
    </>
  );
}

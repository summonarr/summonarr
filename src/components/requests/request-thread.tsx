"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Send, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLiveEvents } from "@/hooks/use-live-events";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { COMMENT_MAX_CHARS } from "@/lib/request-comments";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { failedLoadState, isNearBottom, type ThreadLoadState } from "@/lib/client/thread-view";

interface CommentData {
  id: string;
  createdAt: string;
  body: string;
  fromAdmin: boolean;
  authorId: string;
  // `email` is selected for request managers only.
  author: { name: string | null; email?: string | null; role: string };
}

interface RequestThreadProps {
  requestId: string;
  /** True on the admin queue: the viewer is on the manager side of the thread. */
  viewerIsManager: boolean;
  /** The requester's original note and a decline reason, shown above the thread. */
  requestNote?: string | null;
  declineNote?: string | null;
  /** The thread is closed to the (non-manager) viewer: read-only. */
  closed?: boolean;
  defaultOpen?: boolean;
  /** Comment count known at render time; kept live from the thread once loaded. */
  initialCount?: number;
}

const COUNTER_AT = 1800;

// A collapsible comment thread under a request row. Loads on first open, then
// reloads on the live stream's request:comment event for this request. Bubbles
// follow the chat convention: the viewer's own comments are on the right.
export function RequestThread({
  requestId,
  viewerIsManager,
  requestNote,
  declineNote,
  closed = false,
  defaultOpen = false,
  initialCount = 0,
}: RequestThreadProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [comments, setComments] = useState<CommentData[]>([]);
  const [count, setCount] = useState(initialCount);
  const [loadState, setLoadState] = useState<ThreadLoadState>("idle");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The thread's own scroll box — the only thing ever scrolled, so a reload
  // never moves the page (scrollIntoView scrolls every scrollable ancestor).
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the newest comment on open and after the viewer's own send; a live
  // reload follows only a reader who was already at the bottom.
  const stickRef = useRef(true);
  const { session } = useSummonarrSession();
  // Guardrail 16: dates differ between server and browser locale/timezone.
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const loadSeqRef = useRef(0);

  const load = useCallback(
    (signal?: AbortSignal, { silent = false }: { silent?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      if (!silent) setLoadState("loading");
      return fetch(withBasePath(`/api/requests/${requestId}/comments`), { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: unknown) => {
          if (seq !== loadSeqRef.current) return;
          const el = listRef.current;
          stickRef.current = silent && el ? isNearBottom(el) : true;
          const list = Array.isArray(data) ? (data as CommentData[]) : [];
          setComments(list);
          setCount(list.length);
          setLoadState("ready");
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          if (seq !== loadSeqRef.current) return;
          setLoadState((s) => failedLoadState(s, silent));
        });
    },
    [requestId],
  );

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [open, load]);

  useLiveEvents(
    useCallback(
      (event) => {
        if (event.type !== "request:comment" || event.requestId !== requestId) return;
        if (open) void load(undefined, { silent: true });
        else setCount((c) => c + 1);
      },
      [requestId, open, load],
    ),
  );

  useEffect(() => {
    const el = listRef.current;
    if (!open || loadState !== "ready" || !el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [comments, loadState, open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(withBasePath(`/api/requests/${requestId}/comments`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSendError(data.error ?? t("shared.thread.sendFailed"));
      } else {
        const created: CommentData = await res.json();
        stickRef.current = true;
        // The live event for this comment can reload the thread first.
        setComments((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]));
        setCount((c) => Math.max(c, comments.length + 1));
        setBody("");
      }
    } catch {
      setSendError(t("shared.thread.networkError"));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // A real submit of the textarea's own form, so onSubmit gets a real event.
      e.currentTarget.form?.requestSubmit();
    }
  }

  const label = count > 0 ? t("requests.thread.showCount", { count }) : t("requests.thread.show");

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ds-hover-tint"
        style={{
          marginTop: 6,
          padding: "3px 8px",
          borderRadius: 4,
          fontSize: 11.5,
          color: "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
          background: "var(--ds-bg-2)",
        }}
      >
        {open ? t("requests.thread.hide") : label}
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            borderRadius: 8,
            border: "1px solid var(--ds-border)",
            background: "var(--ds-bg-1)",
          }}
        >
          <div ref={listRef} className="space-y-3 overflow-y-auto" style={{ padding: "12px 14px", maxHeight: 288 }}>
            {requestNote && (
              <p className="whitespace-pre-wrap break-words" style={{ fontSize: 11.5, color: "var(--ds-fg-muted)" }}>
                <span style={{ color: "var(--ds-fg-subtle)" }}>{t("requests.thread.requestNote")}: </span>
                {requestNote}
              </p>
            )}
            {declineNote && (
              <p className="whitespace-pre-wrap break-words" style={{ fontSize: 11.5, color: "var(--ds-fg-muted)" }}>
                <span style={{ color: "var(--ds-fg-subtle)" }}>{t("requests.thread.declineReason")}: </span>
                {declineNote}
              </p>
            )}

            {loadState === "loading" && (
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--ds-fg-subtle)" }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("shared.thread.loading")}
              </div>
            )}
            {loadState === "error" && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-red-400">{t("shared.thread.loadFailed")}</p>
                <Button type="button" size="xs" variant="ghost" onClick={() => void load()}>
                  {t("shared.common.retry")}
                </Button>
              </div>
            )}
            {loadState === "ready" && comments.length === 0 && (
              <p className="text-xs" style={{ color: "var(--ds-fg-subtle)" }}>{t("shared.thread.empty")}</p>
            )}

            {comments.map((c) => {
              const authorName = c.author.name ?? c.author.email ?? t("shared.thread.unknownAuthor");
              // Mine = I wrote it. By role, another manager's reply sat on a
              // manager's own side; `viewerIsManager` is the no-session fallback.
              const isMine = session ? c.authorId === session.user.id : c.fromAdmin === viewerIsManager;
              return (
                <div key={c.id} className={`flex gap-2.5 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
                  <div
                    className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5"
                    style={{
                      background: c.fromAdmin ? "var(--ds-accent)" : "var(--ds-bg-3)",
                      color: c.fromAdmin ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
                    }}
                  >
                    {c.fromAdmin ? <ShieldCheck className="w-3.5 h-3.5" /> : (authorName[0] ?? "?").toUpperCase()}
                  </div>
                  <div className={`flex flex-col gap-0.5 max-w-[75%] ${isMine ? "items-end" : "items-start"}`}>
                    <div
                      className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${isMine ? "rounded-tr-sm" : "rounded-tl-sm"}`}
                      style={{
                        background: c.fromAdmin ? "var(--ds-accent)" : "var(--ds-bg-3)",
                        color: c.fromAdmin ? "var(--ds-accent-fg)" : "var(--ds-fg)",
                      }}
                    >
                      {c.body}
                    </div>
                    <p className="text-[10px] px-1" style={{ color: "var(--ds-fg-subtle)" }}>
                      {c.fromAdmin ? t("shared.thread.admin") : authorName} ·{" "}
                      {mounted
                        ? new Date(c.createdAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {closed ? (
            <p className="text-xs" style={{ padding: "0 14px 12px", color: "var(--ds-fg-subtle)" }}>
              {t("requests.thread.closed")}
            </p>
          ) : (
            <form onSubmit={send} className="flex items-end gap-2" style={{ padding: "0 14px 12px" }}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("shared.thread.placeholder")}
                aria-label={t("shared.thread.message")}
                maxLength={COMMENT_MAX_CHARS}
                rows={2}
                disabled={sending || loadState !== "ready"}
                className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                style={{ background: "var(--ds-bg-2)", borderColor: "var(--ds-border)", color: "var(--ds-fg)" }}
              />
              {body.length > COUNTER_AT && (
                <span className="ds-mono shrink-0 self-end pb-2.5 text-[10px] tabular-nums" style={{ color: "var(--ds-fg-subtle)" }} aria-live="polite">
                  {body.length}/{COMMENT_MAX_CHARS}
                </span>
              )}
              <Button
                type="submit"
                size="sm"
                aria-label={t("shared.thread.send")}
                disabled={!body.trim() || sending || loadState !== "ready"}
                className="h-9 px-3 shrink-0 gap-1.5"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              </Button>
            </form>
          )}
          {sendError && <p className="text-xs text-red-400" style={{ padding: "0 14px 8px" }}>{sendError}</p>}
        </div>
      )}
    </div>
  );
}

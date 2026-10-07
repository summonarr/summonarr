"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Send, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLiveEvents } from "@/hooks/use-live-events";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { Permission, effectivePermissions, hasPermission, parsePermissions } from "@/lib/permissions";

interface IssueMessageData {
  id: string;
  createdAt: string;
  body: string;
  fromAdmin: boolean;
  author: { name: string | null; email: string; role: string };
}

interface IssueThreadProps {
  issueId: string;
  variant?: "inline" | "panel";
  // Which side of the thread the viewer sits on. Omitted, it is derived from the
  // client session with the same MANAGE_ISSUES bit the messages route uses for
  // `fromAdmin`, so every consumer agrees without each page threading it through.
  viewerIsAdmin?: boolean;
}

// Server cap on a message body (api/issues/[id]/messages). The counter appears
// once a draft is within 200 characters of it so the maxLength stop isn't silent.
const MESSAGE_MAX = 2000;
const MESSAGE_COUNTER_AT = 1800;

// Renders an issue's message thread and reply box. Loads the thread once on
// mount, then reloads it whenever the server's live event stream (SSE) sends
// an issuemessage:created event for this issue.
export function IssueThread({ issueId, variant = "inline", viewerIsAdmin: viewerIsAdminProp }: IssueThreadProps) {
  const [messages, setMessages] = useState<IssueMessageData[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guardrail 16: toLocaleString can differ between the server render and the
  // browser (different locale/timezone). Show nothing until mounted in the browser.
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  // Bubbles sit on the viewer's side when the message is THEIRS, not when it is
  // an admin's. `fromAdmin` is MANAGE_ISSUES-derived server-side, so "mine" is
  // `msg.fromAdmin === viewerIsAdmin`. The reporter used to see their own replies
  // on the left in grey — the inverse of the chat convention — and the admin
  // pages only read correctly because admin and viewer coincided there.
  const { session } = useSummonarrSession();
  const viewerIsAdmin =
    viewerIsAdminProp ??
    (session
      ? hasPermission(
          effectivePermissions(session.user.role, parsePermissions(session.user.permissions)),
          Permission.MANAGE_ISSUES,
        )
      : false);
  // The handler takes ⌘↵ AND Ctrl↵; the hint names the one this platform uses.
  // navigator is browser-only, so it is read post-mount (guardrail 16) and the
  // SSR placeholder keeps the generic ⌘ wording until then.
  const shortcut = mounted
    ? /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘↵" : "Ctrl+↵"
    : null;

  const loadMessages = useCallback(
    (signal?: AbortSignal, { silent = false }: { silent?: boolean } = {}) => {
      if (!silent) setLoadState("loading");
      return fetch(withBasePath(`/api/issues/${issueId}/messages`), { signal })
        .then((r) => {
          // A 403/404 returns { error }; without this guard setMessages({error})
          // makes messages.map throw in render (uncaught by .catch).
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data: IssueMessageData[]) => {
          setMessages(Array.isArray(data) ? data : []);
          setLoadState("ready");
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          // A silent refresh failure leaves the existing thread intact rather
          // than blanking a healthy view over a transient hiccup.
          if (!silent) setLoadState("error");
        });
    },
    [issueId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadMessages(ctrl.signal);
    return () => ctrl.abort();
  }, [loadMessages]);

  // The SSE stream emits issuemessage:created when the other party replies;
  // re-pull the thread so the new message appears without a manual refresh.
  useLiveEvents(
    useCallback(
      (event) => {
        if (event.type === "issuemessage:created" && event.issueId === issueId) {
          void loadMessages(undefined, { silent: true });
        }
      },
      [issueId, loadMessages],
    ),
  );

  useEffect(() => {
    if (loadState === "ready") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loadState]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(withBasePath(`/api/issues/${issueId}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSendError(data.error ?? t("shared.thread.sendFailed"));
      } else {
        const msg: IssueMessageData = await res.json();
        // The server also sends an SSE event for this message, and the silent
        // reload it triggers can land first — skip the append if it's already here.
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        setBody("");
        textareaRef.current?.focus();
      }
    } catch {
      setSendError(t("shared.thread.networkError"));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage(e as unknown as React.FormEvent);
    }
  }

  const isPanel = variant === "panel";

  return (
    <div
      className={
        isPanel
          ? "flex-1 min-h-0 flex flex-col bg-zinc-950/50"
          : "border-t border-zinc-800 bg-zinc-950/50 rounded-b-lg"
      }
    >
      <div
        className={
          isPanel
            ? "px-4 py-3 space-y-3 flex-1 min-h-0 overflow-y-auto"
            : "px-4 py-3 space-y-3 max-h-72 overflow-y-auto"
        }
      >
        {loadState === "loading" && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t("shared.thread.loading")}
          </div>
        )}
        {loadState === "error" && (
          // The compose box stays disabled until the thread loads (a send would
          // append to an empty list), so a failed mount fetch needs an explicit
          // retry path — otherwise the only ways back to "ready" are a remount
          // or an SSE-triggered silent reload that needs someone else to post.
          <div className="flex items-center gap-2 py-2">
            <p className="text-xs text-red-400">{t("shared.thread.loadFailed")}</p>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void loadMessages()}
            >
              {t("shared.common.retry")}
            </Button>
          </div>
        )}
        {loadState === "ready" && messages.length === 0 && (
          <p className="text-xs text-zinc-500 py-2">{t("shared.thread.empty")}</p>
        )}
        {messages.map((msg) => {
          // `name` can be null, and `email` is only sent to admins (never on a
          // POST reply), so fall back to "Unknown" — `authorName[0]` below
          // would throw on undefined and blank the whole thread.
          const authorName = msg.author.name ?? msg.author.email ?? t("shared.thread.unknownAuthor");
          const isAdmin = msg.fromAdmin;
          // Side = authorship relative to the viewer; the shield avatar and accent
          // fill still mark admin authorship whichever side it lands on.
          const isMine = msg.fromAdmin === viewerIsAdmin;
          return (
            <div key={msg.id} className={`flex gap-2.5 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
              <div className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5 ${
                isAdmin ? "bg-indigo-700 text-[var(--ds-accent-fg)]" : "bg-zinc-700 text-zinc-300"
              }`}>
                {isAdmin ? <ShieldCheck className="w-3.5 h-3.5" /> : (authorName[0] ?? "?").toUpperCase()}
              </div>

              <div className={`flex flex-col gap-0.5 max-w-[75%] ${isMine ? "items-end" : "items-start"}`}>
                <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  isAdmin
                    ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                    : "bg-zinc-800 text-zinc-200"
                } ${isMine ? "rounded-tr-sm" : "rounded-tl-sm"}`}>
                  {msg.body}
                </div>
                <p className="text-[10px] text-zinc-500 px-1">
                  {isAdmin ? t("shared.thread.admin") : authorName} · {mounted ? new Date(msg.createdAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={sendMessage} className="flex items-end gap-2 px-4 pb-3 pt-1">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            shortcut
              ? t("shared.thread.placeholderShortcut", { shortcut })
              : t("shared.thread.placeholder")
          }
          aria-label={t("shared.thread.message")}
          maxLength={MESSAGE_MAX}
          rows={2}
          disabled={sending || loadState !== "ready"}
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        {body.length > MESSAGE_COUNTER_AT && (
          <span
            className="ds-mono shrink-0 self-end pb-2.5 text-[10px] tabular-nums text-zinc-500"
            aria-live="polite"
          >
            {body.length}/{MESSAGE_MAX}
          </span>
        )}
        <Button
          type="submit"
          size="sm"
          aria-label={t("shared.thread.send")}
          disabled={!body.trim() || sending || loadState !== "ready"}
          className="h-9 px-3 shrink-0 bg-indigo-600 hover:bg-indigo-500 gap-1.5"
        >
          {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        </Button>
      </form>
      {sendError && (
        <p className="text-xs text-red-400 px-4 pb-2">{sendError}</p>
      )}
    </div>
  );
}

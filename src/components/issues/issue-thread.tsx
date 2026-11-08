"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Send, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit, timedFetch } from "@/lib/client/fetch-json";
import { threadCursorOf } from "@/lib/thread-cursor";
import { TRUNCATED_HEADER } from "@/lib/truncation";
import { check, v, type Schema } from "@/lib/validate";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { Permission, effectivePermissions, hasPermission, parsePermissions } from "@/lib/permissions";
import { THREAD_READ_CAP } from "@/lib/api-body-limits";
import { failedLoadState, isNearBottom, mergeThreadReload, prependOlder, type ThreadLoadState } from "@/lib/client/thread-view";

interface IssueMessageData {
  id: string;
  createdAt: string;
  body: string;
  fromAdmin: boolean;
  authorId: string;
  // `email` is selected for MANAGE_ISSUES holders only (GET and POST alike).
  author: { name: string | null; email?: string | null; role: string };
}

// A message as GET and POST /api/issues/[id]/messages answer it, checked before
// it renders: a field of the wrong type is a failed load, never a render crash.
const MessageSchema: Schema<IssueMessageData> = v.object({
  id: v.string(),
  createdAt: v.string(),
  body: v.string(),
  fromAdmin: v.boolean(),
  authorId: v.string(),
  author: v.object({ name: v.nullable(v.string()), email: v.optional(v.nullable(v.string())), role: v.string() }),
});
const ThreadSchema = v.array(MessageSchema);

interface IssueThreadProps {
  issueId: string;
  variant?: "inline" | "panel";
  // Which side of the thread the viewer sits on when there is no session to
  // match authors against. Omitted, it is derived from the client session with
  // the same MANAGE_ISSUES bit the messages route uses for `fromAdmin`.
  viewerIsAdmin?: boolean;
}

// Server cap on a message body (api/issues/[id]/messages). The counter appears
// once a draft is within 200 characters of it so the maxLength stop isn't silent.
const MESSAGE_MAX = 2000;
const MESSAGE_COUNTER_AT = 1800;
const NO_PENDING: ReadonlySet<string> = new Set();

function MessageBubble({ msg, isMine, mounted }: { msg: IssueMessageData; isMine: boolean; mounted: boolean }) {
  const t = useT();
  const locale = useLocale();
  // `name` can be null, and `email` is only sent to MANAGE_ISSUES holders, so
  // fall back to "Unknown" — `authorName[0]` below would throw on undefined
  // and blank the whole thread.
  const authorName = msg.author.name ?? msg.author.email ?? t("shared.thread.unknownAuthor");
  const isAdmin = msg.fromAdmin;
  // Side = authorship relative to the viewer; the shield avatar and accent fill
  // still mark admin authorship whichever side it lands on.
  return (
    <div className={`flex gap-2.5 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
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
          {/* Guardrail 16: toLocaleString can differ between the server render
              and the browser, so the time shows only once mounted. */}
          {isAdmin ? t("shared.thread.admin") : authorName} · {mounted ? new Date(msg.createdAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
        </p>
      </div>
    </div>
  );
}

// Renders an issue's message thread and reply box. Loads the thread once on
// mount, then reloads it whenever the server's live event stream (SSE) sends
// an issuemessage:created event for this issue.
export function IssueThread({ issueId, variant = "inline", viewerIsAdmin: viewerIsAdminProp }: IssueThreadProps) {
  const [messages, setMessages] = useState<IssueMessageData[]>([]);
  const [loadState, setLoadState] = useState<ThreadLoadState>("idle");
  // The route's own reason for a failed load (a reporter is refused while
  // issue reporting is switched off), else the generic sentence.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // Whether messages older than the shown ones may exist (see the request thread).
  const [olderState, setOlderState] = useState<"unknown" | "more" | "none">("unknown");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const olderCtrlRef = useRef<AbortController | null>(null);
  const sendAction = useAsyncAction();
  const sending = sendAction.busy("send");
  // The message list's own scroll box. Only it is ever scrolled: scrollIntoView
  // also scrolls every scrollable ancestor, so each message jumped the whole
  // page to an inline thread inside an admin issue card.
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the newest message on open, after the viewer's own send, and on a
  // live reload only when the reader was already at the bottom.
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guardrail 16: toLocaleString can differ between the server render and the
  // browser (different locale/timezone). Show nothing until mounted in the browser.
  const mounted = useHasMounted();
  const t = useT();
  // Bubbles sit on the viewer's side when the viewer WROTE the message:
  // `msg.authorId === session.user.id`. Matching on role (`fromAdmin`) put every
  // admin's reply on an admin viewer's own side, and all of them on the side of
  // an admin who filed the issue. `viewerIsAdmin` is only the fallback for a
  // render with no session.
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

  // Every load takes a ticket; only the newest ticket may write state, so a
  // slow earlier read can't land after (and overwrite) a newer one.
  const loadSeqRef = useRef(0);
  // Aborted on unmount: no load writes into a thread that is gone.
  const lifeRef = useRef<AbortController | null>(null);

  const loadMessages = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      if (!silent) setLoadState("loading");
      const res = await fetchJson(withBasePath(`/api/issues/${issueId}/messages`), {
        schema: ThreadSchema,
        signal: lifeRef.current?.signal,
      });
      if (seq !== loadSeqRef.current) return;
      if (!res.ok) {
        if (res.kind === "aborted") return;
        // A silent refresh failure keeps a healthy thread intact; one that
        // superseded a first load still pending shows the error and Retry.
        setLoadError(res.kind === "http" && res.error ? res.error : null);
        setLoadState((s) => failedLoadState(s, silent));
        return;
      }
      // Measured before the new list renders: was the reader at the bottom?
      const el = listRef.current;
      stickRef.current = silent && el ? isNearBottom(el) : true;
      setMessages((prev) => mergeThreadReload(res.data, prev, NO_PENDING));
      setOlderState((s) => (s === "unknown" ? (res.data.length >= THREAD_READ_CAP ? "more" : "none") : s));
      setLoadError(null);
      setLoadState("ready");
    },
    [issueId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    lifeRef.current = ctrl;
    void loadMessages();
    return () => ctrl.abort();
  }, [loadMessages]);

  useEffect(() => () => olderCtrlRef.current?.abort(), []);

  // The page of messages older than the oldest shown (the route's `before`
  // cursor); X-Truncated on the answer says whether still older ones remain.
  async function loadOlder() {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    olderCtrlRef.current?.abort();
    const ctrl = new AbortController();
    olderCtrlRef.current = ctrl;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const url = withBasePath(`/api/issues/${issueId}/messages?before=${encodeURIComponent(threadCursorOf(oldest))}`);
      const res = await timedFetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const parsed = check(ThreadSchema, await res.json());
      if (!parsed.ok) throw new Error(parsed.error);
      stickRef.current = false;
      setMessages((prev) => prependOlder(prev, parsed.value));
      setOlderState(res.headers.get(TRUNCATED_HEADER) === "true" ? "more" : "none");
    } catch {
      if (!ctrl.signal.aborted) setOlderFailed(true);
    } finally {
      if (!ctrl.signal.aborted) setLoadingOlder(false);
    }
  }

  // The SSE stream emits issuemessage:created when the other party replies;
  // re-pull the thread so the new message appears without a manual refresh.
  // Coalesced: while one live reload is out, any number of further events
  // cost ONE more read after it, not a read each.
  const liveRef = useRef({ running: false, again: false });
  const liveReload = useCallback(() => {
    const live = liveRef.current;
    if (live.running) {
      live.again = true;
      return;
    }
    live.running = true;
    void (async () => {
      do {
        live.again = false;
        await loadMessages({ silent: true });
      } while (live.again && !lifeRef.current?.signal.aborted);
      live.running = false;
    })();
  }, [loadMessages]);

  // The ids on screen, for a live event naming a message already shown.
  const shownIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    shownIdsRef.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  useLiveEvents(
    useCallback(
      (event) => {
        if (event.type !== "issuemessage:created" || event.issueId !== issueId) return;
        // Already on screen (the viewer's own send landed first): nothing new to read.
        if (event.messageId && shownIdsRef.current.has(event.messageId)) return;
        liveReload();
      },
      [issueId, liveReload],
    ),
  );

  useEffect(() => {
    const el = listRef.current;
    if (loadState !== "ready" || !el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loadState]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    setSendError(null);
    const res = await sendAction.run(
      "send",
      (signal) => fetchJson(withBasePath(`/api/issues/${issueId}/messages`), {
        init: jsonInit("POST", { body: text }),
        schema: MessageSchema,
        signal,
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok && res.kind === "invalid") {
      // Posted (a 2xx), but the answer isn't the message: re-read the thread
      // rather than invite a second send.
      setBody("");
      liveReload();
      return;
    }
    if (!res.ok) {
      // The route's own reason (too long, rate limited, reporting switched
      // off); no answer at all says so.
      setSendError(res.kind === "http" ? res.error || t("shared.thread.sendFailed") : t("shared.thread.networkError"));
      return;
    }
    const msg = res.data;
    stickRef.current = true;
    // The server also sends an SSE event for this message, and the silent
    // reload it triggers can land first — skip the append if it's already here.
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    setBody("");
    // The textarea is only read-only while sending, never disabled, so it
    // kept focus through a ⌘↵ send; after a click on Send this brings the
    // keyboard back to it.
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // A real submit of the textarea's own form, so onSubmit gets a real event.
      e.currentTarget.form?.requestSubmit();
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
        ref={listRef}
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
            <p role="alert" className="text-xs text-red-400">{loadError ?? t("shared.thread.loadFailed")}</p>
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
        {loadState === "ready" && olderState === "more" && (
          <div className="flex items-center gap-2 py-2">
            <Button type="button" size="xs" variant="ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? t("shared.thread.loadingOlder") : t("shared.thread.loadOlder")}
            </Button>
            {olderFailed && <p role="alert" className="text-xs text-red-400">{t("shared.thread.loadOlderFailed")}</p>}
          </div>
        )}
        {messages.map((msg) => {
          const isMine = session ? msg.authorId === session.user.id : msg.fromAdmin === viewerIsAdmin;
          return <MessageBubble key={msg.id} msg={msg} isMine={isMine} mounted={mounted} />;
        })}
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
          // Read-only (not disabled) while sending: a disabled textarea drops
          // focus, so a keyboard user lost their place after every message.
          readOnly={sending}
          aria-busy={sending || undefined}
          disabled={loadState !== "ready"}
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 read-only:opacity-50"
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

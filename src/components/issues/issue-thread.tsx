"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Send, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLiveEvents } from "@/hooks/use-live-events";
import { withBasePath } from "@/lib/base-path";

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
}

// Renders an issue's message thread and reply box; live-refreshes on the SSE
// issuemessage:created event and polls once on mount.
export function IssueThread({ issueId, variant = "inline" }: IssueThreadProps) {
  const [messages, setMessages] = useState<IssueMessageData[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guardrail 16: toLocaleString output diverges between SSR and CSR
  // (locale + timezone resolution). Empty string on the server, fill on mount.
  const mounted = useHasMounted();

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
        setSendError(data.error ?? "Failed to send");
      } else {
        const msg: IssueMessageData = await res.json();
        setMessages((prev) => [...prev, msg]);
        setBody("");
        textareaRef.current?.focus();
      }
    } catch {
      setSendError("Network error — please try again");
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
            Loading messages…
          </div>
        )}
        {loadState === "error" && (
          <p className="text-xs text-red-400 py-2">Failed to load messages.</p>
        )}
        {loadState === "ready" && messages.length === 0 && (
          <p className="text-xs text-zinc-500 py-2">No messages yet. Start the conversation below.</p>
        )}
        {messages.map((msg) => {
          const authorName = msg.author.name ?? msg.author.email;
          const isAdmin = msg.fromAdmin;
          return (
            <div key={msg.id} className={`flex gap-2.5 ${isAdmin ? "flex-row-reverse" : "flex-row"}`}>
              <div className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5 ${
                isAdmin ? "bg-indigo-700 text-white" : "bg-zinc-700 text-zinc-300"
              }`}>
                {isAdmin ? <ShieldCheck className="w-3.5 h-3.5" /> : (authorName[0] ?? "?").toUpperCase()}
              </div>

              <div className={`flex flex-col gap-0.5 max-w-[75%] ${isAdmin ? "items-end" : "items-start"}`}>
                <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                  isAdmin
                    ? "bg-indigo-600 text-white rounded-tr-sm"
                    : "bg-zinc-800 text-zinc-200 rounded-tl-sm"
                }`}>
                  {msg.body}
                </div>
                <p className="text-[10px] text-zinc-500 px-1">
                  {isAdmin ? "Admin" : authorName} · {mounted ? new Date(msg.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
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
          placeholder="Write a message… (⌘↵ to send)"
          aria-label="Message"
          maxLength={2000}
          rows={2}
          disabled={sending || loadState !== "ready"}
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
          aria-label="Send message"
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

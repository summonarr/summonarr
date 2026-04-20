"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

interface IssueMessageData {
  id: string;
  createdAt: string;
  body: string;
  fromAdmin: boolean;
  author: { name: string | null; email: string; role: string };
}

interface IssueThreadProps {
  issueId: string;
  initialCount?: number;

  variant?: "inline" | "panel";
}

export function IssueThread({ issueId, initialCount, variant = "inline" }: IssueThreadProps) {
  const [messages, setMessages] = useState<IssueMessageData[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadState("loading");
    fetch(`/api/issues/${issueId}/messages`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: IssueMessageData[]) => {
        setMessages(data);
        setLoadState("ready");
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setLoadState("error");
      });
    return () => ctrl.abort();
  }, [issueId]);

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
      const res = await fetch(`/api/issues/${issueId}/messages`, {
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
          <p className="text-xs text-zinc-600 py-2">No messages yet. Start the conversation below.</p>
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
                <p className="text-[10px] text-zinc-600 px-1">
                  {isAdmin ? "Admin" : authorName} · {new Date(msg.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
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
          maxLength={2000}
          rows={2}
          disabled={sending || loadState !== "ready"}
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
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

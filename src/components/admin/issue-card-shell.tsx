"use client";

import { useState } from "react";
import { MessageSquare } from "@/components/icons";
import { IssueThread } from "@/components/issues/issue-thread";

interface IssueCardShellProps {
  issueId: string;
  messageCount: number;
  // Below xl the thread only shows inside the card, so the ?selected= issue
  // opens its thread without a second tap on the toggle.
  initialOpen?: boolean;
  children: React.ReactNode;
}

export function IssueCardShell({ issueId, messageCount, initialOpen = false, children }: IssueCardShellProps) {
  const [threadOpen, setThreadOpen] = useState(initialOpen);
  // Selection changes via the URL without remounting the card, so open the
  // thread when this card BECOMES selected (adjust-state-during-render).
  const [prevInitialOpen, setPrevInitialOpen] = useState(initialOpen);
  if (initialOpen !== prevInitialOpen) {
    setPrevInitialOpen(initialOpen);
    if (initialOpen) setThreadOpen(true);
  }

  return (
    <div className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
      <div className="flex items-start gap-4 p-4">
        <div className="flex-1 flex items-start gap-4 min-w-0">
          {children}
        </div>

        {/* Mobile-only thread toggle (hidden ≥xl, where the thread shows inline) */}
        <button
          type="button"
          onClick={() => setThreadOpen((v) => !v)}
          aria-label={`Discussion thread${messageCount > 0 ? ` (${messageCount} ${messageCount === 1 ? "message" : "messages"})` : ""}`}
          aria-expanded={threadOpen}
          className={`xl:hidden shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors border ${
            threadOpen
              ? "bg-indigo-600/20 border-indigo-500/40 text-indigo-400"
              : messageCount > 0
              ? "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-indigo-400 hover:border-indigo-500/40"
              : "border-zinc-800 text-zinc-500 hover:text-zinc-400 hover:border-zinc-700"
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
          {messageCount > 0 ? messageCount : ""}
        </button>
      </div>

      {/* Mobile-only expandable thread panel */}
      {threadOpen && (
        <div className="xl:hidden">
          <IssueThread issueId={issueId} />
        </div>
      )}
    </div>
  );
}

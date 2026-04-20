"use client";

import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { IssueThread } from "@/components/issues/issue-thread";

interface IssueCardShellProps {
  issueId: string;
  messageCount: number;
  children: React.ReactNode;
}

export function IssueCardShell({ issueId, messageCount, children }: IssueCardShellProps) {
  const [threadOpen, setThreadOpen] = useState(false);

  return (
    <div className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
      <div className="flex items-start gap-4 p-4">
        <div className="flex-1 flex items-start gap-4 min-w-0">
          {children}
        </div>

        {}
        <button
          onClick={() => setThreadOpen((v) => !v)}
          className={`xl:hidden shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors border ${
            threadOpen
              ? "bg-indigo-600/20 border-indigo-500/40 text-indigo-400"
              : messageCount > 0
              ? "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-indigo-400 hover:border-indigo-500/40"
              : "border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700"
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          {messageCount > 0 ? messageCount : ""}
        </button>
      </div>

      {}
      {threadOpen && (
        <div className="xl:hidden">
          <IssueThread issueId={issueId} initialCount={messageCount} />
        </div>
      )}
    </div>
  );
}

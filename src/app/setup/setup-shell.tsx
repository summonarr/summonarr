"use client";

import { useState } from "react";
import { SetupForm } from "./setup-form";
import { SetupImportPanel } from "./setup-import-panel";
import { UserPlus, Upload } from "lucide-react";

type Tab = "create" | "restore";

export function SetupShell({ importAvailable }: { importAvailable: boolean }) {
  const [tab, setTab] = useState<Tab>("create");

  if (!importAvailable) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8">
        <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
          <span className="text-indigo-400 text-xs font-medium">
            First user automatically becomes administrator
          </span>
        </div>
        <SetupForm />
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="grid grid-cols-2 border-b border-zinc-800">
        <TabButton active={tab === "create"} onClick={() => setTab("create")}>
          <UserPlus className="w-3.5 h-3.5" />
          Create account
        </TabButton>
        <TabButton active={tab === "restore"} onClick={() => setTab("restore")}>
          <Upload className="w-3.5 h-3.5" />
          Restore backup
        </TabButton>
      </div>
      <div className="p-8">
        {tab === "create" ? (
          <>
            <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
              <span className="text-indigo-400 text-xs font-medium">
                First user automatically becomes administrator
              </span>
            </div>
            <SetupForm />
          </>
        ) : (
          <SetupImportPanel />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors ${
        active
          ? "text-white bg-zinc-900"
          : "text-zinc-400 bg-zinc-950 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

"use client";

import { useState } from "react";
import { SetupForm } from "./setup-form";
import { SetupImportPanel } from "./setup-import-panel";
import { UserPlus, Upload } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";

type Tab = "create" | "restore";

// The login card's recipe (login/page.tsx), token for token: the restore path
// redirects straight from /setup to /login, so the two consecutive auth cards
// must share radius, padding, border and shadow.
const CARD_STYLE: React.CSSProperties = {
  background: "var(--ds-bg-1)",
  border: "1px solid var(--ds-border)",
  borderRadius: "var(--ds-r-xl)",
  boxShadow: "var(--ds-shadow-md)",
};
const CARD_PADDING = 28;

// First-run shell: create-account only, or create/restore tabs when a backup password is configured.
export function SetupShell({ importAvailable }: { importAvailable: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("create");

  if (!importAvailable) {
    return (
      <div style={{ ...CARD_STYLE, padding: CARD_PADDING }}>
        <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
          <span className="text-indigo-400 text-xs font-medium">
            {t("auth.setup.firstUserAdmin")}
          </span>
        </div>
        <SetupForm />
      </div>
    );
  }

  return (
    <div className="overflow-hidden" style={CARD_STYLE}>
      {/* A segmented control (role=group + aria-pressed), the same pattern as
          the login page's provider switcher — not an ARIA tablist, which needs
          ids/aria-controls/aria-labelledby and arrow-key roving focus to be
          complete and announced "tab, selected" with no associated panel. */}
      <div role="group" aria-label={t("auth.setup.mode")} className="grid grid-cols-2 border-b border-zinc-800">
        <TabButton active={tab === "create"} onClick={() => setTab("create")}>
          <UserPlus className="w-3.5 h-3.5" />
          {t("auth.setup.tab.create")}
        </TabButton>
        <TabButton active={tab === "restore"} onClick={() => setTab("restore")}>
          <Upload className="w-3.5 h-3.5" />
          {t("auth.setup.tab.restore")}
        </TabButton>
      </div>
      <div style={{ padding: CARD_PADDING }}>
        {tab === "create" ? (
          <>
            <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
              <span className="text-indigo-400 text-xs font-medium">
                {t("auth.setup.firstUserAdmin")}
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
      aria-pressed={active}
      onClick={onClick}
      className={`ds-hover-tint flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors ${
        active
          ? "text-[var(--ds-fg)] bg-zinc-900"
          : "text-zinc-400 bg-zinc-950 hover:text-zinc-200"
      }`}
      // bg-zinc-900 vs bg-zinc-950 is a ~1.5% lightness step in the light
      // theme, so the selected tab also carries an accent underline that reads
      // in both themes.
      style={active ? { boxShadow: "inset 0 -2px 0 var(--ds-accent)" } : undefined}
    >
      {children}
    </button>
  );
}

"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { rich } from "@/components/settings/forms/rich";
import { useSettingsSave } from "@/components/settings/forms/shared";
import { StatusNote } from "./status-note";

export function GithubTokenCard({
  tokenConfigured,
}: {
  /** A token is stored. The page reads it on the server, so the card fetches nothing to know. */
  tokenConfigured: boolean;
}) {
  const t = useT();
  const [configured, setConfigured] = useState(tokenConfigured);
  const [value, setValue] = useState("");
  // The house settings save: the route's own refusal text (the per-key
  // cooldown, the settings rate limit) stays readable until the next edit or
  // save, and "Saved" only for a 2xx that says ok.
  const saver = useSettingsSave(2000);
  // Which write the ok/error label is about.
  const [action, setAction] = useState<"save" | "remove">("save");
  const running = saver.status === "saving";

  // An empty value removes the stored token: the settings route lets this key
  // be written empty, and the GitHub client reads "" as no token.
  async function write(next: string) {
    if (running) return;
    setAction(next ? "save" : "remove");
    const result = await saver.save({ trashGithubToken: next });
    if (!result.ok) return;
    setConfigured(next !== "");
    setValue("");
  }

  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-100 text-lg">{t("trash.token.title")} <span className="text-xs font-normal text-zinc-500">{t("trash.token.optional")}</span></h2>
        <p className="text-sm text-zinc-500 mt-0.5">
          {rich(t("trash.token.description"), {
            link: (
              <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">
                {t("trash.token.linkText")}
              </a>
            ),
            envVar: <code className="text-zinc-300">TOKEN_ENCRYPTION_KEY</code>,
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label={t("trash.token.inputAria")}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            saver.edited();
          }}
          placeholder={configured ? t("trash.token.replacePlaceholder") : t("trash.token.placeholder")}
          className="flex-1 min-w-40 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
          autoComplete="off"
        />
        <Button
          type="button"
          onClick={() => { if (value) void write(value); }}
          disabled={!value || running}
          className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
        >
          {running && action === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("trash.common.save")}
        </Button>
        {configured && (
          <Button
            type="button"
            onClick={() => void write("")}
            disabled={running}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
          >
            {running && action === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("trash.token.remove")}
          </Button>
        )}
        {configured && !value && (
          <span className="text-xs text-zinc-500 inline-flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400" />
            {t("trash.token.configured")}
          </span>
        )}
        {saver.status === "ok" && <StatusNote tone="ok">{action === "remove" ? t("trash.token.removed") : t("trash.common.saved")}</StatusNote>}
        {saver.status === "error" && <StatusNote tone="error">{saver.message || t("trash.common.saveFailed")}</StatusNote>}
      </div>
    </Card>
  );
}

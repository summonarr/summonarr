"use client";

import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";
import { Card } from "@/components/ui/card";
import { AlertTriangle } from "@/components/icons";
import type { TrashService } from "./types";

export function NotConfiguredBanner({ service }: { service: TrashService }) {
  const t = useT();
  const [before, after] = t("trash.notConfigured", {
    service: service === "RADARR" ? "Radarr" : "Sonarr",
    settings: "\u0000",
  }).split("\u0000");
  return (
    <Card className="bg-amber-500/10 border-amber-500/30 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="text-sm text-amber-400">
        {before}
        <Link href="/settings?tab=media" className="underline hover:text-zinc-100">{t("trash.settingsLink")}</Link>
        {after}
      </div>
    </Card>
  );
}

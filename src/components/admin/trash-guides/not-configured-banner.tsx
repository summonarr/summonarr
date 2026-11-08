"use client";

import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";
import { Card } from "@/components/ui/card";
import { AlertTriangle } from "@/components/icons";
import { rich } from "@/components/settings/forms/rich";
import type { TrashService } from "./types";

export function NotConfiguredBanner({ service }: { service: TrashService }) {
  const t = useT();
  return (
    <Card className="bg-amber-500/10 border-amber-500/30 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="text-sm text-amber-400">
        {/* The translation places {settings}; the link goes exactly there. */}
        {rich(t("trash.notConfigured", { service: service === "RADARR" ? "Radarr" : "Sonarr" }), {
          settings: <Link href="/settings?tab=media" className="underline hover:text-zinc-100">{t("trash.settingsLink")}</Link>,
        })}
      </div>
    </Card>
  );
}

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import type { TrashService } from "./types";

export function NotConfiguredBanner({ service }: { service: TrashService }) {
  return (
    <Card className="bg-amber-500/10 border-amber-500/30 p-4 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="text-sm text-amber-200">
        {service === "RADARR" ? "Radarr" : "Sonarr"} is not configured. Set the URL and API key in{" "}
        <Link href="/settings?tab=media" className="underline hover:text-amber-100">Settings</Link> before applying specs.
      </div>
    </Card>
  );
}

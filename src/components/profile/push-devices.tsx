"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Smartphone, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

interface PushDevice {
  id: string;
  label: string | null;
  createdAt: Date;
}

interface PushDevicesProps {
  devices: PushDevice[];
  cap: number;
}

// Lists registered web-push devices with per-device confirm-then-remove; shows count against cap.
export function PushDevices({ devices, cap }: PushDevicesProps) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const mounted = useHasMounted();
  const action = useAsyncAction();
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  // Devices this page removed. They stay hidden while router.refresh() is in
  // flight, so a removed row never comes back with a live trash button.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState(false);

  async function remove(id: string) {
    setConfirmingRemove(null);
    setError(false);
    const res = await action.run(
      `remove:${id}`,
      (signal) =>
        fetchJson(withBasePath("/api/push/subscribe"), { init: jsonInit("DELETE", { id }), signal }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(true);
      return;
    }
    setRemoved((prev) => new Set(prev).add(id));
    router.refresh();
  }

  const visible = devices.filter((d) => !removed.has(d.id));

  if (visible.length === 0) {
    return (
      <p className="text-sm text-zinc-500">{t("profile.push.empty")}</p>
    );
  }

  const capLabel = cap > 0 ? `${visible.length} / ${cap}` : String(visible.length);

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 mb-3">{t("profile.push.registered", { count: visible.length, label: capLabel })}</p>
      {error && <p role="alert" className="text-xs text-red-400 mb-2">{t("profile.push.error.remove")}</p>}
      {visible.map((device, i) => {
        const deviceLabel = device.label || t("profile.push.deviceN", { n: i + 1 });
        return (
          <div
            key={device.id}
            className="flex items-center justify-between gap-4 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-1)] px-3 py-2"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Smartphone className="w-4 h-4 shrink-0 text-zinc-400" />
              <div className="min-w-0">
                <p className="text-sm text-zinc-200">{deviceLabel}</p>
                <p className="text-xs text-zinc-500">
                  {mounted ? t("profile.push.added", { date: new Date(device.createdAt).toLocaleDateString(locale) }) : ""}
                </p>
              </div>
            </div>
            {confirmingRemove !== device.id && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t("profile.push.removeNamed", { name: deviceLabel })}
                title={t("profile.push.removeDevice")}
                className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-10 w-10 px-0"
                disabled={action.busy(`remove:${device.id}`)}
                onClick={() => setConfirmingRemove(device.id)}
              >
                {action.busy(`remove:${device.id}`)
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />}
              </Button>
            )}
            {confirmingRemove === device.id && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  aria-label={t("profile.push.confirmRemoveNamed", { name: deviceLabel })}
                  className="h-9 px-2.5 gap-1"
                  onClick={() => remove(device.id)}
                  autoFocus
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t("profile.common.remove")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("profile.common.cancelRemove")}
                  className="h-10 w-10 px-0 text-zinc-400 hover:text-zinc-200"
                  onClick={() => setConfirmingRemove(null)}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

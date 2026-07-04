"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Smartphone, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";

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
  const router = useRouter();
  const mounted = useHasMounted();
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function remove(id: string) {
    setRemoving(id);
    setConfirmingRemove(null);
    setError(false);
    try {
      const res = await fetch(withBasePath("/api/push/subscribe"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setRemoving(null);
    }
  }

  if (devices.length === 0) {
    return (
      <p className="text-sm text-zinc-500">No push-notification devices registered.</p>
    );
  }

  const capLabel = cap > 0 ? `${devices.length} / ${cap}` : String(devices.length);

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 mb-3">{capLabel} device{devices.length !== 1 ? "s" : ""} registered</p>
      {error && <p className="text-xs text-red-400 mb-2">Failed to remove device — try again.</p>}
      {devices.map((device, i) => {
        const deviceLabel = device.label || `Device ${i + 1}`;
        return (
          <div
            key={device.id}
            className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-800/50 px-3 py-2"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Smartphone className="w-4 h-4 shrink-0 text-zinc-400" />
              <div className="min-w-0">
                <p className="text-sm text-zinc-200">{deviceLabel}</p>
                <p className="text-xs text-zinc-500">
                  {mounted ? `Added ${new Date(device.createdAt).toLocaleDateString()}` : ""}
                </p>
              </div>
            </div>
            {confirmingRemove !== device.id && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove ${deviceLabel}`}
                title="Remove device"
                className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-9 w-9 p-0"
                disabled={removing === device.id}
                onClick={() => setConfirmingRemove(device.id)}
              >
                {removing === device.id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Trash2 className="w-3.5 h-3.5" />}
              </Button>
            )}
            {confirmingRemove === device.id && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Confirm remove ${deviceLabel}`}
                  className="h-9 px-2.5 bg-red-600 text-white hover:bg-red-500 gap-1"
                  onClick={() => remove(device.id)}
                  autoFocus
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Cancel remove"
                  className="h-9 w-9 p-0 text-zinc-400 hover:text-zinc-200"
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

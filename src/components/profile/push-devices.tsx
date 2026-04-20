"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PushDevice {
  id: string;
  endpoint: string;
  label: string | null;
  createdAt: Date;
}

interface PushDevicesProps {
  devices: PushDevice[];
  cap: number;
}

export function PushDevices({ devices, cap }: PushDevicesProps) {
  const router = useRouter();
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(endpoint: string) {
    setRemoving(endpoint);
    try {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      router.refresh();
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
      {devices.map((device, i) => (
        <div
          key={device.id}
          className="flex items-center justify-between gap-4 rounded-md border border-zinc-800 bg-zinc-800/50 px-3 py-2"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Smartphone className="w-4 h-4 shrink-0 text-zinc-400" />
            <div className="min-w-0">
              <p className="text-sm text-zinc-200">{device.label || `Device ${i + 1}`}</p>
              <p className="text-xs text-zinc-500">
                Added {new Date(device.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 h-7 w-7 p-0"
            disabled={removing === device.endpoint}
            onClick={() => remove(device.endpoint)}
          >
            {removing === device.endpoint
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Trash2 className="w-3.5 h-3.5" />}
          </Button>
        </div>
      ))}
    </div>
  );
}

"use client";

import { Card } from "@/components/ui/card";
import { CheckCircle, XCircle } from "@/components/icons";
import type { ApplyResult } from "./types";

export function ApplyLog({
  results,
  onDismiss,
}: {
  results: ApplyResult[];
  onDismiss: () => void;
}) {
  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);
  return (
    <Card className="bg-zinc-900 border-zinc-800 p-4 text-sm">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-green-400 flex items-center gap-1.5"><CheckCircle className="w-4 h-4" />{successes.length} ok</span>
        {failures.length > 0 && <span className="text-red-400 flex items-center gap-1.5"><XCircle className="w-4 h-4" />{failures.length} failed</span>}
        <button onClick={onDismiss} className="ml-auto text-xs text-zinc-500 hover:text-white">dismiss</button>
      </div>
      {failures.length > 0 && (
        <ul className="space-y-1 mt-2 max-h-40 overflow-y-auto">
          {failures.map((f) => (
            <li key={f.specId} className="text-xs text-red-300">
              <span className="font-medium">{f.name}</span>: {f.error}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// The sync orchestrator's source text: the /api/sync route, then the entry
// (src/lib/sync-orchestrator.ts) and its siblings IN RUN ORDER, so a structural
// pin that compares positions still reads the phases in the order they run and
// moving a function between the modules can't take it out of a pin's view.
// (Not a test file — the runner glob is tests/*.test.mts.)
import { readdirSync, readFileSync } from "node:fs";

export const SYNC_ORCHESTRATOR_FILES = [
  "src/app/api/sync/route.ts",
  "src/lib/sync-orchestrator.ts",
  "src/lib/sync-orchestrator-shared.ts",
  "src/lib/sync-orchestrator-arr.ts",
  "src/lib/sync-orchestrator-libraries.ts",
  "src/lib/sync-orchestrator-marking.ts",
  "src/lib/sync-orchestrator-tmdb-purge.ts",
] as const;

/** Every orchestrator module's source, concatenated (each headed by its path). */
export function syncOrchestratorSource(): string {
  // A sibling added without being listed here would be invisible to every pin.
  const onDisk = readdirSync(new URL("../src/lib/", import.meta.url)).filter((f) => /^sync-orchestrator(-.+)?\.ts$/.test(f));
  const listed = SYNC_ORCHESTRATOR_FILES.filter((p) => p.startsWith("src/lib/"));
  if (onDisk.length !== listed.length) throw new Error(`list every sync-orchestrator module in ${import.meta.url}`);
  return SYNC_ORCHESTRATOR_FILES
    .map((path) => `// ── ${path}\n${readFileSync(new URL(`../${path}`, import.meta.url), "utf8")}`)
    .join("\n");
}

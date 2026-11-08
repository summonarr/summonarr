// The play-history module's source text: the entry file (src/lib/play-history.ts)
// and every play-history-*.ts module beside it that it is split into. Structural
// pins that scan its raw SQL or its exported shapes read this, so moving a
// function between the modules can't take it out of a pin's view. (Not a test
// file — the runner glob is tests/*.test.mts.)
import { readdirSync, readFileSync } from "node:fs";

const LIB = new URL("../src/lib/", import.meta.url);

/** Repo-relative paths of the entry file and every play-history-*.ts module, sorted. */
export function playHistoryModuleFiles(): string[] {
  const split = readdirSync(LIB)
    .filter((f) => f.startsWith("play-history-") && f.endsWith(".ts"))
    .sort()
    .map((f) => `src/lib/${f}`);
  // A pin reading an empty set would pass vacuously.
  if (split.length < 5) throw new Error(`expected the split play-history modules, found ${split.length}`);
  return ["src/lib/play-history.ts", ...split];
}

/** Every play-history module's source, concatenated (each headed by its path). */
export function playHistorySource(): string {
  return playHistoryModuleFiles()
    .map((path) => `// ── ${path}\n${readFileSync(new URL(`../${path}`, import.meta.url), "utf8")}`)
    .join("\n");
}

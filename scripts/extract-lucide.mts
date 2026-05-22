#!/usr/bin/env node
/**
 * Inlines the subset of lucide-react icons used by the app as plain SVG
 * components under src/components/icons/.
 *
 * Reads:
 *   - src/ to discover which icon names are actually imported from
 *     "lucide-react" (including aliased imports like `Check as CheckIcon` and
 *     direct *Icon imports like `CheckIcon`).
 *   - node_modules/lucide-react/dist/esm/lucide-react.mjs to map each PascalCase
 *     name to its source file under dist/esm/icons/.
 *   - Each source file's `__iconNode` array of [tag, attrs] tuples.
 *
 * Writes:
 *   - src/components/icons/<icon-kebab>.tsx for each canonical icon used.
 *   - src/components/icons/index.ts re-exporting every used name (including
 *     direct *Icon aliases that already exist in the upstream package) plus
 *     IconProps / IconComponent type aliases.
 *
 * Invoke with `node scripts/extract-lucide.mts`.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const SRC = join(ROOT, "src");
const PKG_ROOT = join(ROOT, "node_modules/lucide-react/dist/esm");
const ICONS_SRC = join(PKG_ROOT, "icons");
const MAIN_ENTRY = join(PKG_ROOT, "lucide-react.mjs");
const OUT_DIR = join(SRC, "components/icons");

const RESERVED_TYPE_NAMES = new Set(["LucideIcon"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p, out);
    } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function collectImportedNames(): Set<string> {
  const names = new Set<string>();
  const files = walk(SRC);
  // Pick up both legacy "lucide-react" imports and the post-codemod
  // "@/components/icons" imports so the script remains idempotent.
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*?)\}\s*from\s*["'](?:lucide-react|@\/components\/icons)["']/g;
  for (const file of files) {
    // Skip the generated files themselves.
    if (file.includes(`${SRC}/components/icons/`)) continue;
    const text = readFileSync(file, "utf-8");
    if (!text.includes("lucide-react") && !text.includes("@/components/icons")) continue;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(text)) !== null) {
      const inner = match[1];
      for (const rawPart of inner.split(",")) {
        let part = rawPart.trim();
        if (!part) continue;
        part = part.replace(/^type\s+/, "");
        const aliasMatch = part.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/);
        let canonical: string;
        let exposed: string;
        if (aliasMatch) {
          canonical = aliasMatch[1];
          exposed = canonical;
        } else {
          canonical = part.split(/\s+/)[0];
          exposed = canonical;
        }
        if (canonical) names.add(canonical);
        if (exposed) names.add(exposed);
      }
    }
  }
  // IconProps / IconComponent are barrel-level exports, not icons.
  names.delete("IconProps");
  names.delete("IconComponent");
  return names;
}

function buildNameToFileMap(): Map<string, string> {
  const text = readFileSync(MAIN_ENTRY, "utf-8");
  const exportRe = /export\s+\{([^}]+)\}\s+from\s+['"]\.\/icons\/([\w-]+)\.mjs['"]\s*;?/g;
  const map = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = exportRe.exec(text)) !== null) {
    const names = match[1];
    const file = match[2];
    for (const rawPart of names.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const aliasMatch = part.match(/default\s+as\s+([A-Za-z0-9_]+)/);
      if (aliasMatch) {
        map.set(aliasMatch[1], file);
      }
    }
  }
  return map;
}

type IconNode = [string, Record<string, string | number>];

function parseIconNode(filePath: string): IconNode[] {
  const text = readFileSync(filePath, "utf-8");
  const arrMatch = text.match(/const __iconNode\s*=\s*(\[[\s\S]*?\]);/);
  if (!arrMatch) throw new Error(`Could not locate __iconNode in ${filePath}`);
  const source = arrMatch[1];
  const fn = new Function(`return ${source};`) as () => IconNode[];
  return fn();
}

function toKebabCase(pascal: string): string {
  return pascal
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function attrToJsx(key: string, value: string | number): string {
  if (typeof value === "number") return `${key}={${value}}`;
  const escaped = value.replace(/"/g, "&quot;");
  return `${key}="${escaped}"`;
}

function renderIconComponent(componentName: string, nodes: IconNode[]): string {
  const children = nodes
    .map(([tag, attrs]) => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "key") continue;
        parts.push(attrToJsx(k, v));
      }
      return `      <${tag}${parts.length ? " " + parts.join(" ") : ""} />`;
    })
    .join("\n");
  return `import type { IconProps } from "./index";

export function ${componentName}({ size, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 24}
      height={size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
${children}
    </svg>
  );
}
`;
}

function main() {
  if (!existsSync(MAIN_ENTRY)) {
    console.error(`[extract-lucide] Missing lucide-react sources at ${MAIN_ENTRY}`);
    process.exit(1);
  }

  const requested = collectImportedNames();
  for (const reserved of RESERVED_TYPE_NAMES) requested.delete(reserved);

  const nameToFile = buildNameToFileMap();
  const missing: string[] = [];
  const fileToCanonical = new Map<string, string>();
  const exposedToCanonical = new Map<string, string>();

  for (const name of requested) {
    const file = nameToFile.get(name);
    if (!file) {
      missing.push(name);
      continue;
    }
    if (!fileToCanonical.has(file)) {
      fileToCanonical.set(file, name);
    }
    exposedToCanonical.set(name, file);
  }

  if (missing.length) {
    console.error(`[extract-lucide] Unknown lucide names: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Reset the output dir.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const componentFiles = new Map<string, { canonical: string; path: string }>();

  for (const [file, canonical] of fileToCanonical) {
    const nodes = parseIconNode(join(ICONS_SRC, `${file}.mjs`));
    const componentName = canonical;
    const fileName = toKebabCase(canonical) + ".tsx";
    writeFileSync(join(OUT_DIR, fileName), renderIconComponent(componentName, nodes));
    componentFiles.set(file, { canonical: componentName, path: fileName });
  }

  // Build the barrel.
  const exportLines: string[] = [];
  exportLines.push(`import type { JSX, SVGProps } from "react";`);
  exportLines.push("");
  exportLines.push(`export type IconProps = SVGProps<SVGSVGElement> & {`);
  exportLines.push(`  size?: number | string;`);
  exportLines.push(`};`);
  exportLines.push(`export type IconComponent = (props: IconProps) => JSX.Element;`);
  exportLines.push("");

  const seen = new Set<string>();
  const sortedNames = [...exposedToCanonical.keys()].sort((a, b) => a.localeCompare(b));
  for (const exposed of sortedNames) {
    const file = exposedToCanonical.get(exposed)!;
    const meta = componentFiles.get(file)!;
    const importBase = "./" + toKebabCase(meta.canonical);
    if (exposed === meta.canonical) {
      exportLines.push(`export { ${meta.canonical} } from "${importBase}";`);
    } else {
      exportLines.push(`export { ${meta.canonical} as ${exposed} } from "${importBase}";`);
    }
    seen.add(exposed);
  }

  writeFileSync(join(OUT_DIR, "index.ts"), exportLines.join("\n") + "\n");
}

main();

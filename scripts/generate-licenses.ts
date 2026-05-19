#!/usr/bin/env tsx
/**
 * Third-party license notice generator.
 *
 * Summonarr is distributed as a Docker image built from Next.js standalone
 * output, which traces only the JS modules required at runtime and strips
 * the LICENSE/NOTICE files from node_modules. The permissive licenses in the
 * tree (MIT/BSD/ISC/Apache-2.0) require their copyright + permission notices
 * to travel with any distribution, and the bundled LGPL libvips binary
 * (via `sharp`) requires its license text + relink notice. This script
 * regenerates THIRD_PARTY_LICENSES.txt so the shipped artifact carries them.
 *
 * It enumerates the *production* dependency set from package-lock.json
 * (lockfile v3: every package keyed by install path, with `dev`/`devOptional`
 * flags and inline `license`/`version`). The lockfile is used rather than
 * `npm ls` because `npm ls --json` emits a deduped tree — a package can
 * appear first as a childless stub, hiding its subtree (this masked the
 * LGPL libvips binaries under `sharp`). The lockfile is flat and exact.
 *
 * Usage:
 *   npm run licenses:generate          # writes ./THIRD_PARTY_LICENSES.txt
 *   tsx scripts/generate-licenses.ts --check   # exit 1 if out of date (CI)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_FILE = join(process.cwd(), "THIRD_PARTY_LICENSES.txt");
const LICENSE_FILE_RE = /^(licen[sc]e|copying|notice)(\..*)?$/i;

/**
 * Some packages (notably sharp's prebuilt libvips binaries, LGPL-3.0) ship
 * NO license file. Copyleft licenses require the full text to travel with
 * the distribution, so we bundle canonical FSF copies under licenses/ and
 * reference them from an appendix. LGPL-3.0 is GPL-3.0 plus additional
 * permissions and incorporates the GPL text by reference, so any LGPL
 * reference pulls in GPL-3.0 too.
 */
const CANONICAL: Record<string, string[]> = {
  "Apache-2.0": ["Apache-2.0"],
  "LGPL-3.0-or-later": ["LGPL-3.0", "GPL-3.0"],
  "LGPL-3.0-only": ["LGPL-3.0", "GPL-3.0"],
  "LGPL-3.0": ["LGPL-3.0", "GPL-3.0"],
  "GPL-3.0-or-later": ["GPL-3.0"],
  "GPL-3.0-only": ["GPL-3.0"],
  "GPL-3.0": ["GPL-3.0"],
};

interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  devOptional?: boolean;
  extraneous?: boolean;
  link?: boolean;
  // Platform-gating constraints. Their presence marks an optional native
  // binary (e.g. @img/sharp-*) of which `npm ci` installs only the host's
  // copy — see gating note in productionPackages().
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

interface Pkg {
  name: string;
  version: string;
  license: string;
  text: string;
  path: string;
  /**
   * True when the package is a platform-gated optional native binary. Only
   * the host platform's copy is physically installed, so reading its on-disk
   * LICENSE would make the generated file non-deterministic across OSes
   * (macOS-generated vs Linux-CI `--check`). For these we never read disk
   * text and rely solely on the lockfile `license` + canonical text, which
   * is identical on every platform.
   */
  gated: boolean;
}

/**
 * Resolve the canonical-text files for an SPDX license expression. Handles
 * simple `A AND B` / `A OR B` compounds (e.g. sharp's win32 binaries are
 * `Apache-2.0 AND LGPL-3.0-or-later`) by unioning the canonical set of each
 * component. Returns undefined when no component has canonical text.
 */
function canonicalFor(license: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of license.split(/\s+(?:AND|OR)\s+/i)) {
    const part = raw.replace(/[()]/g, "").trim();
    for (const c of CANONICAL[part] ?? []) {
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Production packages = node_modules entries in the lockfile that are not
 * dev-only. `dev` / `devOptional` mark dev-tree packages; `optional` (prod
 * optional, e.g. sharp's platform binaries) is intentionally kept. `link`
 * entries are workspace symlinks with no distributable content.
 */
function productionPackages(): Pkg[] {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, LockEntry>;
  };
  const seen = new Map<string, Pkg>();
  for (const [path, e] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/")) continue;
    if (e.dev || e.devOptional || e.extraneous || e.link) continue;
    if (!e.version) continue;
    // Package name = path after the LAST "node_modules/" segment, keeping
    // the scope (e.g. node_modules/a/node_modules/@img/x -> @img/x).
    const name = path.slice(path.lastIndexOf("node_modules/") + 13);
    const key = `${name}@${e.version}`;
    if (seen.has(key)) continue;
    // Platform-gated optional binary: `npm ci` installs only the host's
    // copy, so its on-disk LICENSE (and package.json) is absent on other
    // OSes. Never touch disk for these — the output must be byte-identical
    // whether generated on a dev macOS box or in Linux CI.
    const gated = Boolean(e.os || e.cpu || e.libc);
    seen.set(key, {
      name,
      version: e.version,
      license: e.license ?? (gated ? "UNKNOWN" : declaredLicense(path)),
      text: gated ? "" : readLicenseText(path),
      path,
      gated,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readLicenseText(pkgPath: string): string {
  if (!pkgPath || !existsSync(pkgPath)) return "";
  let entries: string[];
  try {
    entries = readdirSync(pkgPath);
  } catch {
    return "";
  }
  const file = entries.find((f) => LICENSE_FILE_RE.test(f));
  if (!file) return "";
  try {
    return readFileSync(join(pkgPath, file), "utf8").trim();
  } catch {
    return "";
  }
}

function declaredLicense(pkgPath: string): string {
  try {
    const pj = JSON.parse(
      readFileSync(join(pkgPath, "package.json"), "utf8"),
    ) as { license?: string; licenses?: Array<{ type?: string }> };
    if (typeof pj.license === "string") return pj.license;
    if (pj.licenses?.[0]?.type) return pj.licenses[0].type;
  } catch {
    /* fall through */
  }
  return "UNKNOWN";
}

function build(): string {
  const pkgs = productionPackages();

  const header = [
    "THIRD-PARTY SOFTWARE NOTICES AND LICENSES",
    "",
    "Summonarr is licensed under AGPL-3.0-only (see LICENSE).",
    "It incorporates the third-party packages listed below. Each is",
    "distributed under its own license; the full text of each is reproduced",
    "verbatim where the package provided one.",
    "",
    "Note: the `sharp` image library bundles a prebuilt libvips binary",
    "(@img/sharp-libvips-*) licensed under LGPL-3.0-or-later. You may modify",
    "and relink it: it is installed as a separate native module and is not",
    "statically combined into the application bundle.",
    "",
    `Generated by scripts/generate-licenses.ts — ${pkgs.length} production packages.`,
    "=".repeat(78),
    "",
  ].join("\n");

  const neededCanonical = new Set<string>();

  const body = pkgs
    .map((p) => {
      const block = [`${p.name}@${p.version}`, `License: ${p.license}`];
      const canon = canonicalFor(p.license);
      if (p.text) {
        block.push("", p.text);
      } else if (canon) {
        for (const c of canon) neededCanonical.add(c);
        block.push(
          "",
          `(No license file shipped in the package. Full text of ` +
            `${canon.join(" + ")} is reproduced in the CANONICAL LICENSE ` +
            `TEXTS appendix at the end of this file.)`,
        );
      } else {
        block.push("", "(No license file shipped in the package.)");
      }
      return block.join("\n");
    })
    .join(`\n\n${"-".repeat(78)}\n\n`);

  let appendix = "";
  if (neededCanonical.size > 0) {
    const order = ["Apache-2.0", "LGPL-3.0", "GPL-3.0"].filter((c) =>
      neededCanonical.has(c),
    );
    appendix =
      `\n\n${"=".repeat(78)}\n` +
      `CANONICAL LICENSE TEXTS\n` +
      `${"=".repeat(78)}\n\n` +
      order
        .map((c) => {
          const text = readFileSync(
            join(process.cwd(), "licenses", `${c}.txt`),
            "utf8",
          ).trim();
          return `>>> ${c} <<<\n\n${text}`;
        })
        .join(`\n\n${"-".repeat(78)}\n\n`);
  }

  return `${header}${body}${appendix}\n`;
}

const content = build();

if (process.argv.includes("--check")) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
  if (current !== content) {
    console.error(
      "[licenses] THIRD_PARTY_LICENSES.txt is stale. Run: npm run licenses:generate",
    );
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(OUT_FILE, content);

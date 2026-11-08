// GitHub access for the TRaSH-Guides catalog: the one recursive tree listing
// (api.github.com) and the raw file downloads (raw.githubusercontent.com), both
// through safeFetchTrusted with a fixed host allowlist (guardrail 5a).
import { prisma } from "./prisma";
import { safeFetchTrusted } from "./safe-fetch";
import { check, v } from "./validate";

export const TRASH_REPO = "TRaSH-Guides/Guides";
export const TRASH_BRANCH = "master";
const USER_AGENT = "Summonarr-TrashSync/0.1";

const RAW_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const TREE_FETCH_TIMEOUT_MS = 30_000;
const RAW_FETCH_TIMEOUT_MS = 15_000;

const TreeEntrySchema = v.object({ path: v.string(), sha: v.string(), type: v.string() });
// Every entry must parse: a listing with a dropped entry would read as the
// upstream removing that spec, and the refresh prunes by the listing.
const TreeResponseSchema = v.object({
  tree: v.optional(v.array(TreeEntrySchema)),
  truncated: v.optional(v.boolean()),
});

export interface GhTreeEntry {
  path: string;
  sha: string;
  type: string;
}

// The one recursive TRaSH tree fetch, for callers that refresh BOTH services
// and want to hand the same listing to each `refreshCatalog` call (the nightly
// cron and the admin refresh route).
export type TrashTree = { entries: GhTreeEntry[]; truncated: boolean };

// A full refresh calls ghAuthHeaders() (and so loadGithubToken()) once per file —
// potentially hundreds of times for a real TRaSH catalog. Memoize with a short
// TTL + in-flight coalescing (mirrors omdb.ts's getApiKey()) so a refresh issues
// one Setting read instead of hundreds; an admin's token change still propagates
// within the TTL window.
const GITHUB_TOKEN_TTL_MS = 30_000;
let githubTokenCache: { value: string | null; at: number } | null = null;
let githubTokenInflight: Promise<string | null> | null = null;

async function loadGithubToken(): Promise<string | null> {
  if (githubTokenCache && Date.now() - githubTokenCache.at < GITHUB_TOKEN_TTL_MS) {
    return githubTokenCache.value;
  }
  if (githubTokenInflight) return githubTokenInflight;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "trashGithubToken" } });
    const value = row?.value && row.value.length > 0 ? row.value : null;
    githubTokenCache = { value, at: Date.now() };
    return value;
  })();
  githubTokenInflight = p;
  p.finally(() => { githubTokenInflight = null; }).catch(() => {});
  return p;
}

// Test-support only: the cache above is module-level state that would
// otherwise leak a stale (or absent) token across unrelated test() blocks in
// the same file/process. Not used by production code paths.
export function __resetGithubTokenCacheForTests(): void {
  githubTokenCache = null;
  githubTokenInflight = null;
}

async function ghAuthHeaders(): Promise<HeadersInit> {
  const token = await loadGithubToken();
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `token ${token}` } : {}),
  };
}

// Returns the tree entries plus a flag — callers persist truncation state via setRefreshTruncated()
async function ghTree(repo: string, branch: string): Promise<TrashTree> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await safeFetchTrusted(url, {
    allowedHosts: ["api.github.com"],
    headers: await ghAuthHeaders(),
    timeoutMs: TREE_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub tree fetch failed for ${repo}@${branch}: ${res.status} ${body.slice(0, 120)}`);
  }
  const parsed = check(TreeResponseSchema, await res.json().catch(() => undefined));
  if (!parsed.ok) {
    throw new Error(`GitHub tree response for ${repo}@${branch} was malformed: ${parsed.error}`);
  }
  const data = parsed.value;
  if (data.truncated) {
    // GitHub caps recursive tree responses; truncation here means some specs will be silently skipped this run
    console.warn(`[trash] tree truncated for ${repo}@${branch} — upstream has exceeded GitHub's tree cap`);
  }
  return { entries: data.tree ?? [], truncated: data.truncated === true };
}

export async function fetchTrashTree(): Promise<TrashTree> {
  return ghTree(TRASH_REPO, TRASH_BRANCH);
}

export async function setRefreshTruncated(truncated: boolean): Promise<void> {
  if (truncated) {
    const value = new Date().toISOString();
    await prisma.setting.upsert({
      where: { key: "trashLastRefreshTruncatedAt" },
      update: { value },
      create: { key: "trashLastRefreshTruncatedAt", value },
    });
  } else {
    // Best-effort clear; absence of the row means "never truncated" so a missing-row is fine
    await prisma.setting.deleteMany({ where: { key: "trashLastRefreshTruncatedAt" } });
  }
}

// One file of the catalog, as text.
export async function fetchTrashFile(path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${TRASH_REPO}/${TRASH_BRANCH}/${path}`;
  const res = await safeFetchTrusted(url, {
    allowedHosts: ["raw.githubusercontent.com"],
    // Send the GitHub token here too (ghAuthHeaders), not only on the api.github.com
    // tree call — a full refresh pulls hundreds of files from raw.githubusercontent.com,
    // so the configured token should authenticate the high-volume path (private
    // repos + higher rate limits), not just the single tree request.
    headers: await ghAuthHeaders(),
    timeoutMs: RAW_FETCH_TIMEOUT_MS,
    maxResponseBytes: RAW_FETCH_MAX_BYTES,
  });
  if (!res.ok) {
    throw new Error(`raw fetch failed: ${path} ${res.status}`);
  }
  return res.text();
}

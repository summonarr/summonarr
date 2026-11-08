// docker-entrypoint.sh, the Dockerfile's runner stage and the compose
// healthchecks: how the container boots, schedules its cron jobs, polls play
// history and stops. The script itself can't run under this suite (it needs
// Postgres and a built app), so it is pinned two ways: structurally over the
// source, and by running the extracted pieces — the scheduler and the shutdown
// tail under `sh` with stubs and a fake clock, and the database probe, the
// pre-push scripts and the play-history poller under node against stand-in
// servers on 127.0.0.1. No database, no outside network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");
const ENTRY = read("docker-entrypoint.sh");
const DOCKERFILE = read("Dockerfile");
const COMPOSES = ["docker-container/docker-compose.yml", "docker-compose.yml"] as const;

type Heredoc = { tag: string; body: string; at: number };

/** Every `node --input-type=module <<'TAG'` heredoc in the script, in order. */
function heredocs(): Heredoc[] {
  const out: Heredoc[] = [];
  for (const m of ENTRY.matchAll(/node --input-type=module <<'([A-Z_]+)'[^\n]*\n([\s\S]*?)\n\1\n/g)) {
    out.push({ tag: m[1], body: m[2], at: m.index ?? -1 });
  }
  return out;
}

/**
 * A top-level shell function's definition, `name() {` through its closing `}`
 * at column 0 — skipping heredoc bodies, whose JavaScript has column-0 braces.
 */
function shFunction(name: string): string {
  const lines = ENTRY.split("\n");
  const start = lines.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name}() not found in docker-entrypoint.sh`);
  let heredocEnd: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (heredocEnd !== null) {
      if (lines[i] === heredocEnd) heredocEnd = null;
      continue;
    }
    const open = lines[i].match(/<<'?([A-Z_]+)'?/);
    if (open) heredocEnd = open[1];
    else if (lines[i] === "}") return lines.slice(start, i + 1).join("\n") + "\n";
  }
  assert.fail(`${name}() has no closing brace`);
}

function cronTable(): string {
  const m = ENTRY.match(/^_CRON_JOBS='\n[\s\S]*?\n'\n/m);
  assert.ok(m, "_CRON_JOBS table not found");
  return m[0];
}

type Job = { label: string; urlVar: string; path: string; intervalVar: string; def: string; quiet: string; delay: number; loop: string };

function jobs(): Job[] {
  return cronTable()
    .split("\n")
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [label, urlVar, path, intervalVar, def, quiet, delay, loop] = l.split("|");
      return { label, urlVar, path, intervalVar, def, quiet, delay: Number(delay), loop };
    });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "summonarr-entrypoint-"));
}

/** Run a node ES module from stdin; resolves with its exit code and output. */
function runNode(
  source: string,
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(source);
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

test("a stop during boot is handled from the first line: the boot trap precedes every boot step", () => {
  const bootTrap = ENTRY.indexOf("trap 'echo \"[entrypoint] Stop requested during boot — exiting.\"; exit 143' TERM");
  assert.ok(bootTrap > 0, "boot-phase TERM trap");
  assert.ok(ENTRY.indexOf("exit 130' INT") > bootTrap, "boot-phase INT trap");
  for (const step of ["/run/secrets/cron_secret", "_db_wait=", "_pre_upgrade_dump ||", "node node_modules/prisma/build/index.js db push"]) {
    assert.ok(bootTrap < ENTRY.indexOf(step), `the trap must be installed before ${step}`);
  }
});

test("tini is PID 1, so the shell's traps run and orphans are reaped", () => {
  assert.match(DOCKERFILE, /apk add --no-cache [^\n]*\\\n\s+postgresql17-client tini && \\/);
  assert.match(DOCKERFILE, /\nENTRYPOINT \["\/sbin\/tini", "--", "\.\/docker-entrypoint\.sh"\]\n/);
});

test("the database password can come from a Docker secret, read before DATABASE_URL is built", () => {
  const file = ENTRY.indexOf("if [ -f /run/secrets/postgres_password ]; then");
  const required = ENTRY.indexOf('if [ -z "${POSTGRES_PASSWORD:-}" ]; then');
  const url = ENTRY.indexOf('export DATABASE_URL="postgresql://summonarr:${ENCODED_PASSWORD}@postgres:5432/summonarr"');
  assert.ok(file > 0 && required > 0 && url > 0);
  assert.ok(file < required && required < url, "secret file → presence check → URL");
  const block = ENTRY.slice(file, required);
  assert.match(block, /POSTGRES_PASSWORD=\$\(cat \/run\/secrets\/postgres_password\) \|\| \{[^}]*exit 1; \}/, "a read error is fatal");
  assert.match(block, /\[ -z "\$POSTGRES_PASSWORD" \] && \{[^}]*empty"; exit 1; \}/, "an empty file is fatal");
  assert.match(block, /export POSTGRES_PASSWORD/);
});

test("boot waits (bounded) for Postgres before the first step that needs it, and never fails on the wait", () => {
  const wait = ENTRY.indexOf('_db_wait=$(_cron_int "${SUMMONARR_DB_WAIT_SECONDS:-60}" 60)');
  assert.ok(wait > ENTRY.indexOf("export DATABASE_URL="), "after DATABASE_URL exists");
  assert.ok(wait < ENTRY.indexOf("\n_pre_upgrade_dump ||"), "before the pre-upgrade dump decides 'unreachable = skip'");
  assert.ok(wait < ENTRY.indexOf("Deduplicating PlayHistory"), "before the pre-push scripts");
  const loop = ENTRY.slice(wait, ENTRY.indexOf("\ndone\n", wait));
  assert.match(loop, /DBWAIT_EOF' && break/);
  assert.match(loop, /did not answer within \$\{_db_wait\}s — continuing boot\."\n\s+_db_unanswered=1\n\s+break/, "a timeout continues boot (and tells the dump not to probe)");
  assert.doesNotMatch(loop.replace(/process\.exit\(code\)/, ""), /\bexit\b/, "the wait never ends boot itself");
});

// Fake Postgres: answers the startup packet with one ErrorResponse, then hangs up.
function fakePostgres(code: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => {
      sockets.push(socket);
      socket.once("data", () => {
        const field = (type: string, value: string) => Buffer.concat([Buffer.from(type), Buffer.from(value), Buffer.from([0])]);
        const body = Buffer.concat([field("S", "FATAL"), field("V", "FATAL"), field("C", code), field("M", "stand-in"), Buffer.from([0])]);
        const len = Buffer.alloc(4);
        len.writeInt32BE(body.length + 4);
        socket.end(Buffer.concat([Buffer.from("E"), len, body]));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `postgresql://summonarr:pw@127.0.0.1:${port}/summonarr`,
        close: () => { for (const s of sockets) s.destroy(); server.close(); },
      });
    });
  });
}

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

test("the database probe waits only while Postgres is not answering", async () => {
  const probe = heredocs().find((h) => h.tag === "DBWAIT_EOF");
  assert.ok(probe, "DBWAIT_EOF heredoc");
  const run = (url: string, cwd = REPO) => runNode(probe.body, { cwd, env: { DATABASE_URL: url } });

  // Nothing listening: not up yet → 1 (wait and retry).
  assert.equal((await run(`postgresql://summonarr:pw@127.0.0.1:${await closedPort()}/summonarr`)).code, 1);

  // Postgres answered — with a refused password or a missing database, db push
  // must report that, not a 60s wait → 0.
  for (const code of ["28P01", "3D000"]) {
    const pg = await fakePostgres(code);
    try {
      assert.equal((await run(pg.url)).code, 0, `SQLSTATE ${code} ends the wait`);
    } finally {
      pg.close();
    }
  }

  // "the database system is starting up" → still waiting.
  const starting = await fakePostgres("57P03");
  try {
    assert.equal((await run(starting.url)).code, 1);
  } finally {
    starting.close();
  }

  // No pg module to probe with: don't wait for nothing.
  const dir = tempDir();
  try {
    assert.equal((await run("postgresql://x:y@127.0.0.1:1/z", dir)).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every best-effort pre-push script loads pg inside its try, so even a failed load only warns", () => {
  const withPg = heredocs().filter((h) => h.body.includes("import('pg')"));
  assert.equal(withPg.length, 5, "the database probe and the four pre-push scripts");
  for (const { tag, body } of withPg) {
    const tryAt = body.indexOf("try {");
    assert.ok(tryAt >= 0 && tryAt < body.indexOf("import('pg')"), `${tag}: import('pg') must sit inside the try`);
    assert.ok(tryAt < body.indexOf("new Client("), `${tag}: the Client must be built inside the try`);
    assert.doesNotMatch(body, /\bclient\.end\(\)\.catch/, `${tag}: client may be unset in the finally — client?.end()`);
  }
  // Run each pre-push script where pg can't be found: it must warn and exit 0,
  // because `set -e` turns any other exit into a failed boot.
  const dir = tempDir();
  try {
    for (const { tag, body } of withPg.filter((h) => h.tag !== "DBWAIT_EOF")) {
      const r = spawnSync(process.execPath, ["--input-type=module"], {
        cwd: dir,
        input: body,
        env: { ...process.env, DATABASE_URL: "postgresql://x:y@127.0.0.1:1/z" },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, `${tag}: ${r.stderr}`);
      assert.match(r.stderr, /failed — continuing boot/, `${tag} warns`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pre-upgrade dump clears a cut-off .partial before taking a new one", () => {
  const fn = shFunction("_pre_upgrade_dump");
  const clear = fn.indexOf('rm -f "$_dir"/summonarr-pre-upgrade-*.dump.partial 2>/dev/null || true');
  assert.ok(clear > fn.indexOf("is not a writable directory"), "only once the directory is known writable");
  assert.ok(clear < fn.indexOf("pg_dump -h postgres"), "before the new dump starts");
});

test("the pre-upgrade dump ignores exactly the raw-ops indexes Prisma re-reports, and lists every one of them", () => {
  const noise = ENTRY.match(/^_PRISMA_DIFF_NOISE='([^']*)'$/m);
  assert.ok(noise, "_PRISMA_DIFF_NOISE");
  const listed = noise[1].split(/\s+/).filter(Boolean);
  // Every raw-ops index in the schema (Prisma's default name: <Model>_<cols>_idx)
  // must be listed, or each boot reads it as a pending change and dumps.
  const schema = read("prisma/schema.prisma");
  const rawOps: string[] = [];
  for (const m of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)) {
    for (const ix of m[2].matchAll(/@@index\(\[([^\]]*raw\([^\]]*)\]\)/g)) {
      const cols = ix[1].split(",").map((c) => c.trim().replace(/\(.*$/, ""));
      rawOps.push(`${m[1]}_${cols.join("_")}_idx`);
    }
  }
  assert.ok(rawOps.length > 0, "the TmdbCache text_pattern_ops index parsed");
  for (const name of rawOps) assert.ok(listed.includes(name), `${name} is missing from _PRISMA_DIFF_NOISE`);

  // Run the filter: the noise pair goes, a real change (even one naming a
  // longer index that starts with the same text) stays.
  const fn = shFunction("_pre_upgrade_dump");
  const filter = fn.slice(fn.indexOf("  _pending=$("), fn.indexOf('  [ -z "$_pending" ] && return 0'));
  const run = (diff: string) => spawnSync("sh", ["-c", `set -e\n${noise[0]}\n${filter}printf '%s' "$_pending"`], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", _diff: diff },
    encoding: "utf8",
  }).stdout;
  const pair = '-- DropIndex\nDROP INDEX "TmdbCache_key_idx";\n\n-- CreateIndex\nCREATE INDEX "TmdbCache_key_idx" ON "TmdbCache"("key" text_pattern_ops);\n';
  assert.equal(run(pair), "");
  assert.equal(run(`${pair}CREATE INDEX "TmdbCache_key_idx2" ON "TmdbCache"("key");\n`), 'CREATE INDEX "TmdbCache_key_idx2" ON "TmdbCache"("key");');
});

test("the pre-upgrade dump never waits on an unanswered database", () => {
  const fn = shFunction("_pre_upgrade_dump");
  const skip = fn.indexOf('if [ -n "$_db_unanswered" ]; then');
  assert.ok(skip >= 0 && skip < fn.indexOf("psql "), "a database the boot wait gave up on is skipped before any probe");
  const wait = ENTRY.slice(ENTRY.indexOf("_db_unanswered=\"\""), ENTRY.indexOf("\n_pre_upgrade_dump() {"));
  assert.match(wait, /continuing boot\."\n\s+_db_unanswered=1\n\s+break/, "the wait's timeout sets the flag");
  assert.match(fn, /PGCONNECT_TIMEOUT=10 psql /, "the probe's connect is bounded");
  assert.match(fn, /PGCONNECT_TIMEOUT=10 timeout "\$_tmo" pg_dump -h postgres/, "the dump's connect is bounded");
  assert.match(fn, /_diff=\$\(timeout \d+ node node_modules\/prisma\/build\/index\.js migrate diff /, "the diff is bounded");
});

test("the PlayHistory dedup scans only while no unique index enforces the key", () => {
  const body = heredocs().find((h) => h.tag === "DEDUP_EOF")?.body ?? "";
  assert.match(body, /FROM pg_index i/);
  assert.match(body, /i\.indisunique AND i\.indisvalid/);
  assert.match(body, /i\.indpred IS NULL AND i\.indexprs IS NULL/, "a partial or expression index proves nothing");
  assert.match(body, /const res = enforced \? \{ rowCount: 0 \} : await client\.query\(`\s*DELETE FROM "PlayHistory"/);
});

test("the playDuration clamp judges watched against the credits start, like the app's finalize", () => {
  const body = heredocs().find((h) => h.tag === "BACKFILL_EOF")?.body ?? "";
  assert.match(body, /column_name = 'creditsStartMs'/, "an older table without the column still runs");
  assert.match(body, /WHEN "creditsStartMs" > 0 AND "creditsStartMs" <= duration::bigint \* 1000\s+THEN "creditsStartMs"::float \/ 1000 ELSE duration::float END/);
  assert.match(body, /::float \/ \(\$\{effective\}\) \* 100\) >= \$1/);
  const judge = read("src/lib/play-history-record.ts");
  assert.match(judge, /session\.creditsStartMs != null && session\.creditsStartMs > 0 && session\.creditsStartMs <= totalDurationMs/, "the rule the SQL mirrors");
});

test("a cron URL override may be https: the call speaks TLS instead of refusing the scheme", async () => {
  // A plain TCP listener that hangs up: an https client fails the handshake,
  // an http-only client would refuse the URL before connecting.
  const server = createNetServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const fn = shFunction("_cron_sync");
    const body = heredocs().find((h) => h.tag === "JSEOF" && fn.includes(h.body));
    assert.ok(body, "_cron_sync's heredoc");
    const r = await runNode(body.body, {
      cwd: REPO,
      env: { SYNC_CALL_URL: `https://127.0.0.1:${port}/api/sync`, SYNC_CALL_LABEL: "sync", SYNC_CALL_TIMEOUT_MS: "5000", CRON_SECRET: "x" },
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[sync failed: /);
    assert.doesNotMatch(r.stdout, /not supported/, r.stdout);
    const poller = shFunction("_play_history_loop");
    assert.match(poller, /import https from 'node:https';/);
    assert.match(poller, /const client = URL\.canParse\(url\) && new URL\(url\)\.protocol === 'https:' \? https : http;/);
  } finally {
    server.close();
  }
});

// ── the cron scheduler ───────────────────────────────────────────────────────

const SHORT_CADENCE = ["watch-sync", "arr-watch", "arr-snapshots"];

test("the schedule table: one row per job, short-cadence jobs in their own loop, defaults in step with compose and Settings", () => {
  const rows = jobs();
  assert.equal(rows.length, 19);
  assert.equal(new Set(rows.map((j) => j.intervalVar)).size, rows.length, "interval vars are the per-job state keys — unique");
  for (const j of rows) {
    assert.match(j.intervalVar, /^[A-Z_]+_INTERVAL$/);
    assert.match(j.urlVar, /^[A-Z_]+_URL$/);
    assert.match(j.def, /^[1-9]\d*$/);
    assert.ok(Number.isInteger(j.delay) && j.delay >= 0, j.label);
    assert.ok(j.quiet === "" || j.quiet === "quiet", j.label);
    assert.equal(j.loop, SHORT_CADENCE.includes(j.label) ? "fast" : "main", `${j.label} loop`);
  }
  // Every *_INTERVAL the cron section reads is a table row (the play-history
  // loop and the retry/timeout knobs are not scheduled jobs).
  const cronSection = ENTRY.slice(ENTRY.indexOf("_CRON_JOBS='"));
  const used = new Set([...cronSection.matchAll(/\b([A-Z_]+_INTERVAL)\b/g)].map((m) => m[1]));
  for (const v of ["PLAY_HISTORY_SYNC_INTERVAL", "CRON_RETRY_INTERVAL"]) used.delete(v);
  assert.deepEqual([...used].sort(), rows.map((j) => j.intervalVar).sort());

  const compose = read("docker-container/docker-compose.yml");
  const settings = read("src/app/(app)/settings/_tabs/cron-jobs.ts");
  for (const j of rows) {
    assert.ok(compose.includes(`${j.intervalVar}: "\${${j.intervalVar}:-${j.def}}"`), `compose default for ${j.intervalVar}`);
    // The System tab's CRON_JOBS table lists every job, with its interval var and default.
    const s = settings.match(new RegExp(`envVar: "${j.intervalVar}", defaultSeconds: "(\\d+)"`));
    assert.ok(s, `the System tab lists ${j.label} (${j.intervalVar})`);
    assert.equal(s[1], j.def, `Settings page default for ${j.intervalVar}`);
  }
});

function schedulerHarness(dir: string): string {
  const defs = [shFunction("_cron_int"), shFunction("_cron_next"), cronTable(), shFunction("_cron_banner"), shFunction("_cron_loop")].join("\n");
  writeFileSync(join(dir, "defs.sh"), defs);
  const harness = `set -e
. "$DIR/defs.sh"
CRON_BASE="http://localhost:3000"
echo 1000 > "$DIR/clock"
date() { cat "$DIR/clock"; }
sleep() { echo $(( $(cat "$DIR/clock") + 60 )) > "$DIR/clock"; }
_cron_sync() {
  _t=$(cat "$DIR/clock")
  if [ "$_t" -gt "$STOP_AT" ]; then exit 0; fi
  echo "$_t $2 $1 $3" >> "$DIR/calls"
  if [ "$2" = "\${FAIL_JOB:-}" ]; then return 1; fi
  return 0
}
if [ "$LOOP" = banner ]; then _cron_banner; else _cron_loop "$LOOP"; fi
`;
  const path = join(dir, "harness.sh");
  writeFileSync(path, harness);
  return path;
}

function runScheduler(loop: string, env: Record<string, string> = {}): { out: string; calls: string[] } {
  const dir = tempDir();
  try {
    const r = spawnSync("sh", [schedulerHarness(dir)], {
      // A clean environment: no *_INTERVAL or *_URL from the outer one leaks in.
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DIR: dir, LOOP: loop, STOP_AT: "3000", ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    let calls: string[] = [];
    try {
      calls = readFileSync(join(dir, "calls"), "utf8").replace(/\n$/, "").split("\n");
    } catch { /* no job ran */ }
    return { out: r.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the banner prints every job's interval as the scheduler will use it, and flags an unusable value", () => {
  const { out } = runScheduler("banner", { SYNC_INTERVAL: "1h", ARR_WATCH_INTERVAL: "0900", WARM_OMDB_INTERVAL: "7200" });
  assert.match(out, /SYNC_INTERVAL=1h is not a whole number of seconds — using 3600\./);
  assert.match(out, /ARR_WATCH_INTERVAL=0900 is not a whole number of seconds — using 900\./);
  const banner = out.split("\n").find((l) => l.startsWith("Cron started."));
  assert.ok(banner, "the smoke test and README look for 'Cron started.'");
  for (const j of jobs()) assert.ok(banner.includes(`  ${j.label}: `), `${j.label} in the banner`);
  assert.match(banner, /  sync: 3600s  /);
  assert.match(banner, /  warm-omdb: 7200s  /);
  assert.match(banner, /  purge-sessions: 86400s  /, "the job the old hand-written banner forgot");
  assert.doesNotMatch(banner, /1hs/);
});

test("the main loop runs its jobs at their first-run offsets, in table order, honouring URL overrides", () => {
  const { calls } = runScheduler("main", { STOP_AT: "1300", SYNC_URL: "http://override.invalid/sync" });
  assert.deepEqual(calls, [
    "1060 sync http://override.invalid/sync ",
    "1060 warm-list-cache http://localhost:3000/api/cron/warm-list-cache ",
    "1060 warm-activity http://localhost:3000/api/cron/warm-activity quiet",
    "1120 upcoming http://localhost:3000/api/sync/upcoming ",
    "1180 ratings http://localhost:3000/api/sync/ratings ",
    "1240 warm-mdblist http://localhost:3000/api/cron/warm-mdblist ",
    "1300 warm-omdb http://localhost:3000/api/cron/warm-omdb ",
  ]);
});

test("the fast loop runs only the short-cadence jobs, each on its interval, and retries a failure sooner", () => {
  const { calls } = runScheduler("fast", { STOP_AT: "2600", FAIL_JOB: "arr-watch", CRON_RETRY_INTERVAL: "120" });
  const at = (label: string) => calls.filter((c) => c.split(" ")[1] === label).map((c) => Number(c.split(" ")[0]));
  assert.deepEqual([...new Set(calls.map((c) => c.split(" ")[1]))].sort(), [...SHORT_CADENCE].sort());
  assert.deepEqual(at("arr-snapshots"), [1300, 1600, 1900, 2200, 2500], "every 300s after +300");
  assert.deepEqual(at("watch-sync"), [1780, 2080, 2380], "every 300s after +780");
  assert.deepEqual(at("arr-watch"), [1660, 1780, 1900, 2020, 2140, 2260, 2380, 2500], "failing: CRON_RETRY_INTERVAL, not 900s");
});

// ── play history ─────────────────────────────────────────────────────────────

test("play history is polled by one long-lived node process, not a node per poll", () => {
  const fn = shFunction("_play_history_loop");
  assert.equal(fn.match(/node --input-type=module/g)?.length, 1);
  assert.doesNotMatch(fn, /^\s*_cron_sync /m, "no per-poll _cron_sync call");
  assert.match(fn, /if \[ "\$INTERVAL" -lt 1 \]; then INTERVAL=1; fi/, "0 must not become a back-to-back loop");
  assert.match(fn, /node --input-type=module <<'JSEOF' \|\| true/, "a dead poller never trips set -e");
  assert.doesNotMatch(fn, /Authorization[^\n]*\$CRON_SECRET|CRON_SECRET="/, "the secret reaches node through the environment only");
});

test("the poller is serial, waits the interval after each answer, and survives failures", async () => {
  const fn = shFunction("_play_history_loop");
  const body = heredocs().find((h) => h.tag === "JSEOF" && fn.includes(h.body));
  assert.ok(body, "the poller's heredoc");

  const t0 = Date.now();
  let inFlight = 0;
  let maxInFlight = 0;
  const polls: Array<{ start: number; end: number; auth: string | undefined }> = [];
  const server = createHttpServer((req, res) => {
    if (req.url === "/api/health") {
      res.statusCode = Date.now() - t0 > 300 ? 200 : 503;
      res.end("{}");
      return;
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const poll = { start: Date.now(), end: 0, auth: req.headers.authorization };
    polls.push(poll);
    setTimeout(() => {
      inFlight--;
      poll.end = Date.now();
      if (polls.length === 1) { res.statusCode = 500; res.end("no"); }
      else if (polls.length === 2) req.socket.destroy();
      else res.end("ok");
    }, 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await new Promise<{ stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module"], {
        cwd: REPO,
        env: {
          ...process.env,
          PH_URL: `http://127.0.0.1:${port}/api/sync/play-history`,
          PH_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
          PH_INTERVAL_MS: "1000", // the shell never passes less than 1s
          PH_TIMEOUT_MS: "5000",
          CRON_SECRET: "cron-secret-under-test",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      const timer = setInterval(() => {
        if (polls.length >= 3 && polls[2].end > 0) { clearInterval(timer); child.kill(); }
      }, 20);
      child.on("close", () => resolve({ stdout }));
      child.stdin.end(body.body);
    });
    assert.equal(maxInFlight, 1, "never two polls at once");
    assert.equal(polls.length, 3, "still polling after a 500 and a dropped connection");
    for (const p of polls) assert.equal(p.auth, "Bearer cron-secret-under-test");
    assert.ok(polls[0].start - t0 >= 300, "waits for /api/health first");
    for (let i = 1; i < polls.length; i++) {
      assert.ok(polls[i].start - polls[i - 1].end >= 950, `poll ${i + 1} waited the 1s interval after the answer`);
    }
    assert.match(r.stdout, /\[play-history failed: 500\]/);
    assert.match(r.stdout, /\[play-history failed: socket hang up\]/);
  } finally {
    server.close();
  }
});

// ── run phase and shutdown ───────────────────────────────────────────────────

function tailHarness(dir: string, serverScript: string): string {
  const tail = ENTRY.slice(ENTRY.indexOf("\n_cron_banner\n"));
  assert.ok(tail.includes("\nnode server.js &\n"));
  writeFileSync(join(dir, "server.sh"), serverScript);
  const harness = `set -e
_cron_banner() { :; }
_cron_loop() { while true; do sleep 1; done; }
_play_history_loop() { while true; do sleep 1; done; }
${tail.replace("\nnode server.js &\n", `\nsh "${join(dir, "server.sh")}" &\n`)}`;
  const path = join(dir, "tail.sh");
  writeFileSync(path, harness);
  return path;
}

test("both cron loops and the poller start, and shutdown stops all of them", () => {
  const tail = ENTRY.slice(ENTRY.indexOf("\n_cron_banner\n"));
  assert.match(tail, /\n_cron_loop main &\nCRON_PID=\$!\n/);
  assert.match(tail, /\n_cron_loop fast &\nFAST_PID=\$!\n/);
  assert.match(tail, /trap "kill \$NODE_PID \$CRON_PID \$FAST_PID \$PH_PID 2>\/dev\/null \|\| true" TERM INT/);
  assert.match(tail, /kill "\$CRON_PID" "\$FAST_PID" "\$PH_PID" 2>\/dev\/null \|\| true/);
  assert.match(tail, /exit "\$rc"\n$/, "the script ends with node's status");
});

test("the container exits with node's own status", () => {
  const dir = tempDir();
  try {
    for (const code of [0, 3]) {
      const r = spawnSync("sh", [tailHarness(dir, `sleep 0.2; exit ${code}`)], { encoding: "utf8" });
      assert.equal(r.status, code, r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop waits for node to finish draining, then exits with its status", async () => {
  const dir = tempDir();
  try {
    const path = tailHarness(dir, "trap 'sleep 0.3; echo drained; exit 0' TERM\necho up\nwhile true; do sleep 0.1; done\n");
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn("sh", [path], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stopped = false;
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (!stopped && stdout.includes("up")) {
          stopped = true;
          setTimeout(() => child.kill("SIGTERM"), 100);
        }
      });
      child.on("close", (code) => resolve({ code, stdout }));
    });
    assert.match(r.stdout, /drained/, "node's shutdown ran to the end");
    assert.equal(r.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── image ────────────────────────────────────────────────────────────────────

test("the runner stage's app tree is root-owned; only /data and the Next cache are the runtime user's", () => {
  const runner = DOCKERFILE.slice(DOCKERFILE.indexOf(" AS runner"));
  const copies = [...runner.matchAll(/^COPY [^\n]*$/gm)].map((m) => ({ line: m[0], at: m.index ?? 0 }));
  assert.ok(copies.length >= 10, "the runner's COPY lines");
  for (const c of copies) assert.doesNotMatch(c.line, /--chown/, c.line);
  const chown = runner.match(/^RUN chmod \+x \.\/docker-entrypoint\.sh && \\\n\s+mkdir -p \/data \/app\/\.next\/cache && \\\n\s+chown -R nextjs:nodejs \/data \/app\/\.next\/cache\n/m);
  assert.ok(chown, "one RUN makes and hands over exactly /data and /app/.next/cache");
  const chownAt = chown.index ?? 0;
  assert.ok(copies.every((c) => c.at < chownAt), "after the last COPY, so no copy resets them");
  assert.equal((runner.match(/chown/g) ?? []).length, 1, "no other ownership change in the runner");
  assert.ok(runner.indexOf("\nUSER nextjs\n") > chownAt);
});

test("the image healthcheck probes with busybox wget, not a node process per probe", () => {
  const m = DOCKERFILE.match(/HEALTHCHECK [^\n]*\\\n\s+CMD ([^\n]*)\n/);
  assert.ok(m, "Dockerfile HEALTHCHECK command");
  assert.match(m[1], /^wget -q -Y off -T \d+ -O \/dev\/null "http:\/\/127\.0\.0\.1:\$\{PORT:-3000\}\$\{BASE_PATH\}\/api\/health" \|\| exit 1$/);
});

test("the healthcheck start period covers a slow boot, the same in the Dockerfile and both compose files", () => {
  const m = DOCKERFILE.match(/HEALTHCHECK [^\n]*--start-period=(\d+)s/);
  assert.ok(m, "Dockerfile HEALTHCHECK start period");
  const period = Number(m[1]);
  assert.ok(period >= 300, "the database wait, a pre-upgrade dump and db push all run before node starts");
  for (const f of COMPOSES) {
    const c = read(f).match(/\n\s+start_period: (\d+)s\n/);
    assert.ok(c, `${f}: start_period`);
    assert.equal(Number(c[1]), period, `${f} matches the Dockerfile`);
  }
});

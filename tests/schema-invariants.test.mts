// Structural invariants of prisma/schema.prisma — the schema facts that
// guardrails 19, 28, 32 and 35 depend on, none of which any compiler, linter or
// existing test checks.
//
// Why a schema test at all: this project is schema-first (guardrail 3). There is
// no migrations directory to review — changes are applied by `prisma db push`,
// which the Docker entrypoint runs automatically at boot. So a one-word edit
// here is not a proposal, it is a deployment. `db push` is perfectly happy to
// turn `onDelete: Restrict` back into `Cascade`; it will not warn, no type
// changes, no test fails, and the next `MediaServerUser` delete silently and
// unrecoverably destroys that person's entire watch history — which the live
// poller is the SOLE writer of (guardrail 19), so nothing can rebuild it.
//
// tests/backup-schema.test.mts already parses this file, but for a different
// question: that one pins the BACKUP_TABLES manifest against the model list and
// checks FK ordering for restore. It says nothing about delete behaviour, key
// membership, or which columns exist. This file covers those.
//
// What is pinned, and what breaks if it drifts:
//
//   - guardrail 28 — PlayHistory and ActiveSession FK MediaServerUser with
//     onDelete: Restrict. The FK used to be Cascade, and a degraded Jellyfin
//     /Users fetch (a 200 with a truncated list) once made the hourly prune
//     delete every absent user and cascade-erase their history. Restrict turns
//     that into a loud throw at the delete instead of silent data loss.
//   - guardrail 19 — PlayHistory's @@unique([source, serverInstance,
//     sourceSessionId]) IS the whole Jellyfin dedup story now that the backfill
//     crons are gone. recordCompletedSession relies on createMany({
//     skipDuplicates: true }) against exactly this constraint; narrowing it
//     double-counts watches and inflates play counts and watch hours.
//   - guardrail 32 — arrInstance sits inside the @@id/@@unique key of all six
//     arr-scoped models, and the deprecated is4k column is RETAINED but out of
//     every key. Dropping is4k makes `db push` a destructive change that
//     docker-entrypoint.sh refuses (exit 1) — a boot failure on upgrade.
//   - guardrail 35 — serverInstance sits inside the key of all five
//     media-server-scoped models, and TVEpisodeCache deliberately has NO
//     serverInstance column. That absence is load-bearing: it is precisely why
//     the episode rewrite is gated all-or-nothing across instances instead of
//     looping delete+insert per instance.
//
// Parsing is deliberately textual and dependency-free rather than via Prisma's
// own AST — the point is to read what a reviewer would read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

// ── a small schema reader ───────────────────────────────────────────────────

interface CompositeKey {
  kind: "id" | "unique";
  cols: string[];
}
/** One @@index — column names only (sort modifiers stripped), plus its access method. */
interface SecondaryIndex {
  cols: string[];
  /** true for a `type: Gin` index; false for the btree default. */
  gin: boolean;
}
interface Model {
  name: string;
  fields: string[];
  keys: CompositeKey[];
  indexes: SecondaryIndex[];
  /** Full source line of each field carrying an @relation attribute. */
  relations: string[];
  body: string;
}

function parseModels(src: string): Map<string, Model> {
  const models = new Map<string, Model>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [, name, body] = m;
    const fields: string[] = [];
    const keys: CompositeKey[] = [];
    const indexes: SecondaryIndex[] = [];
    const relations: string[] = [];
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line) continue;
      if (line.startsWith("@@")) {
        const k = /^@@(id|unique)\(\s*\[([^\]]*)\]/.exec(line);
        if (k) keys.push({ kind: k[1] as "id" | "unique", cols: k[2].split(",").map((s) => s.trim()) });
        const ix = /^@@index\(\s*\[([^\]]*)\]([^)]*)/.exec(line);
        if (ix) {
          indexes.push({
            // `startedAt(sort: Desc)` → `startedAt`: only the column identity
            // matters for prefix reasoning — a btree serves an equality scan on
            // its leading columns regardless of their sort direction.
            cols: ix[1].split(",").map((s) => s.trim().replace(/\(.*$/, "")),
            gin: /type:\s*Gin/.test(ix[2]),
          });
        }
        continue;
      }
      const f = /^(\w+)\s+\S/.exec(line);
      if (f) fields.push(f[1]);
      if (line.includes("@relation")) relations.push(line);
    }
    models.set(name, { name, fields, keys, indexes, relations, body });
  }
  return models;
}

const models = parseModels(SCHEMA);

function model(name: string): Model {
  const m = models.get(name);
  assert.ok(m, `model ${name} is missing from schema.prisma — this pin needs updating deliberately, not silently`);
  return m;
}

const inAnyKey = (m: Model, col: string): boolean => m.keys.some((k) => k.cols.includes(col));

// ── non-vacuity ─────────────────────────────────────────────────────────────

test("the schema parser found a realistic model set — a broken parse must not pass vacuously", () => {
  assert.ok(models.size > 30, `only ${models.size} models parsed from schema.prisma — the parser is broken`);
  // Spot-check the parse actually captured structure, not just names.
  const ph = model("PlayHistory");
  assert.ok(ph.fields.length > 15, "PlayHistory's fields did not parse");
  assert.ok(ph.keys.length > 0, "PlayHistory's composite keys did not parse");
  assert.ok(ph.indexes.length > 5, "PlayHistory's @@index lines did not parse");
  assert.ok(ph.relations.length > 0, "PlayHistory's relations did not parse");
  // The sort-modifier strip must actually happen, or the prefix pin below
  // compares `startedAt(sort: Desc)` against `startedAt` and never matches.
  assert.ok(
    ph.indexes.some((ix) => ix.cols.length === 2 && ix.cols[0] === "source" && ix.cols[1] === "startedAt"),
    `PlayHistory's [source, startedAt(sort: Desc)] index did not parse to [source, startedAt]: ${JSON.stringify(ph.indexes)}`,
  );
});

// ── guardrail 28: play history outlives the account that made it ────────────

const HISTORY_OWNING_MODELS = ["PlayHistory", "ActiveSession"] as const;

test("guardrail 28: PlayHistory and ActiveSession FK MediaServerUser with onDelete: Restrict", () => {
  for (const name of HISTORY_OWNING_MODELS) {
    const rels = model(name).relations.filter((r) => r.includes("MediaServerUser"));
    assert.equal(rels.length, 1, `${name} must have exactly one MediaServerUser relation (found ${rels.length})`);
    assert.match(
      rels[0],
      /onDelete:\s*Restrict/,
      `${name} → MediaServerUser is not onDelete: Restrict.\n  ${rels[0]}\n` +
        "Guardrail 28: this FK was Cascade once, and a degraded Jellyfin /Users fetch made the hourly prune " +
        "cascade-erase real watch history. The live poller is the sole writer (guardrail 19) so it cannot be " +
        "rebuilt. Restrict makes a hard delete THROW instead — soft-delete with active=false.",
    );
  }
});

test("guardrail 28: no MediaServerUser relation anywhere cascades a delete", () => {
  // The rule is about the data, not two specific models — a new table FKing
  // MediaServerUser with Cascade reopens the same hole.
  const offenders: string[] = [];
  for (const m of models.values()) {
    for (const rel of m.relations) {
      if (rel.includes("MediaServerUser") && /onDelete:\s*Cascade/.test(rel)) {
        offenders.push(`${m.name}: ${rel}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a Cascade delete on MediaServerUser destroys watch history (guardrail 28)");
});

// ── guardrail 19: the dedup constraint IS the dedup story ──────────────────

test("guardrail 19: PlayHistory is deduped on exactly [source, serverInstance, sourceSessionId]", () => {
  const ph = model("PlayHistory");
  const key = ph.keys.find((k) => k.cols.includes("sourceSessionId"));
  assert.ok(key, "PlayHistory has no composite key over sourceSessionId");
  assert.deepEqual(
    key.cols,
    ["source", "serverInstance", "sourceSessionId"],
    "recordCompletedSession dedups with createMany({ skipDuplicates: true }) against THIS constraint. With the " +
      "Jellyfin backfill crons gone it is the entire dedup story — narrowing it double-counts watches and " +
      "inflates play counts and watch hours on admin/activity.",
  );
  assert.equal(key.kind, "unique", "it must be a @@unique — the row keeps its own id primary key");
});

test("guardrail 19: the @@unique is the ONLY key over sourceSessionId — no shadow @@index([source, sourceSessionId])", () => {
  // A 2-column @@index([source, sourceSessionId]) shipped beside the unique for
  // a long time. Nothing ever read it: the single writer is recordCompletedSession's
  // createMany({ skipDuplicates: true }), whose ON CONFLICT DO NOTHING is resolved
  // by the @@unique's own btree, and no Prisma `where` or raw-SQL predicate
  // filters on (source, sourceSessionId). It was a leftover from before
  // serverInstance widened the unique key — one extra btree maintained on every
  // session finalize (the 5s poller and the SSE path), consulted by nothing.
  const ph = model("PlayHistory");
  const shadows = ph.indexes.filter((ix) => ix.cols.includes("sourceSessionId"));
  assert.deepEqual(
    shadows,
    [],
    `PlayHistory carries a secondary @@index over sourceSessionId: ${JSON.stringify(shadows)}. The dedup ` +
      "constraint's own btree already covers every lookup on it; a second index is pure write amplification.",
  );
});

// ── guardrail 32: arrInstance replaced is4k, non-destructively ──────────────

const ARR_SCOPED_MODELS = [
  "MediaRequest",
  "RadarrWantedItem",
  "RadarrAvailableItem",
  "SonarrWantedItem",
  "SonarrAvailableItem",
  "TrashApplication",
] as const;

test("guardrail 32: arrInstance is a column AND sits inside the key on every arr-scoped model", () => {
  for (const name of ARR_SCOPED_MODELS) {
    const m = model(name);
    assert.ok(m.fields.includes("arrInstance"), `${name} is missing the arrInstance column`);
    assert.ok(
      inAnyKey(m, "arrInstance"),
      `${name}'s @@id/@@unique does not include arrInstance — two instances would collide on one row. ` +
        `keys: ${JSON.stringify(m.keys)}`,
    );
  }
});

test("guardrail 32: the deprecated is4k column is RETAINED and is in NO key", () => {
  for (const name of ARR_SCOPED_MODELS) {
    const m = model(name);
    assert.ok(
      m.fields.includes("is4k"),
      `${name} dropped the is4k column. That makes db push a genuinely destructive change, which ` +
        "docker-entrypoint.sh refuses (exit 1) — every upgrading deployment fails to boot. It stays until a " +
        "later release when every deployment has migrated (mirrors User.autoApprove/quotaExempt).",
    );
    assert.equal(
      inAnyKey(m, "is4k"),
      false,
      `${name} still keys on is4k — the instance identity moved to arrInstance; a two-column identity ` +
        "re-splits the default and 4K rows.",
    );
  }
});

test("guardrail 32: arrInstance defaults to \"\" so existing rows land on the default instance", () => {
  for (const name of ARR_SCOPED_MODELS) {
    const body = model(name).body;
    const decl = body.split("\n").find((l) => /^\s*arrInstance\s/.test(l)) ?? "";
    assert.match(
      decl,
      /@default\(""\)/,
      `${name}.arrInstance must @default("") — the entrypoint's pre-push hook backfills from is4k, and a ` +
        "column with no default cannot be added to a populated table.",
    );
  }
});

// ── guardrail 35: serverInstance, and the one table that must NOT have it ───

const MEDIA_SCOPED_MODELS = [
  "PlexLibraryItem",
  "JellyfinLibraryItem",
  "MediaServerUser",
  "PlayHistory",
  "ActiveSession",
] as const;

test("guardrail 35: serverInstance is a column AND sits inside the key on every media-scoped model", () => {
  for (const name of MEDIA_SCOPED_MODELS) {
    const m = model(name);
    assert.ok(m.fields.includes("serverInstance"), `${name} is missing the serverInstance column`);
    assert.ok(
      inAnyKey(m, "serverInstance"),
      `${name}'s @@id/@@unique does not include serverInstance. Plex ratingKeys are small server-local ` +
        `integers, so two servers legitimately reuse the same key for different titles — they would collide ` +
        `on one row. keys: ${JSON.stringify(m.keys)}`,
    );
  }
});

test('guardrail 35: serverInstance defaults to "" — byte-identical behaviour for single-server deployments', () => {
  for (const name of MEDIA_SCOPED_MODELS) {
    const decl = model(name).body.split("\n").find((l) => /^\s*serverInstance\s/.test(l)) ?? "";
    assert.match(
      decl,
      /@default\(""\)/,
      `${name}.serverInstance must @default(""). Unlike is4k→arrInstance there is nothing to backfill: a plain ` +
        "ADD COLUMN with a \"\" default is already correct for every existing row.",
    );
  }
});

test("guardrail 35: TVEpisodeCache has NO serverInstance column — the absence is load-bearing", () => {
  const tec = model("TVEpisodeCache");
  assert.equal(
    tec.fields.includes("serverInstance"),
    false,
    "TVEpisodeCache gained a serverInstance column. Episodes are TMDB-anchored shared data, and the whole " +
      "all-or-nothing gating of the episode rewrite (allEpisodesFetched && writable.length === fetched.length " +
      "&& writable.length > 0, done ONCE at the end rather than per instance) exists precisely because this " +
      "table cannot be scoped. Adding the column without rewriting that logic leaves the gate wrong in a way " +
      "nothing else detects.",
  );
  // The key it does have accumulates across servers under one `source` namespace.
  assert.ok(
    tec.keys.some((k) => k.cols.includes("source") && k.cols.includes("tmdbId")),
    "TVEpisodeCache keys on (source, tmdbId, …) — the shared namespace the three read sites gate visibility on",
  );
});

// ── schema-first hygiene ───────────────────────────────────────────────────

test("every model still maps to its own name — no @@map indirection", () => {
  // backup-schema.test.mts pins this for the backup manifest; repeated here for
  // the raw-SQL layer, which spells physical table names by hand ("PlayHistory",
  // "MediaServerUser", …) in ~70 $queryRawUnsafe strings that no type checks.
  const mapped = [...models.values()].filter((m) => /@@map\(/.test(m.body));
  assert.deepEqual(
    mapped.map((m) => m.name),
    [],
    "an @@map renames the physical table while the hand-written raw SQL keeps the model name — every " +
      "aggregate query on that table breaks at runtime only.",
  );
});

test("the raw-SQL layer's hardcoded table names all exist as models", () => {
  // The other half of the same risk: a model RENAME leaves the SQL strings
  // pointing at a table that no longer exists, and only a live query notices.
  const playHistory = readFileSync(new URL("../src/lib/play-history.ts", import.meta.url), "utf8");
  const referenced = new Set<string>();
  // Quoted PascalCase only. Models are PascalCase and columns are camelCase, so
  // this cleanly skips EXTRACT(DOW FROM "startedAt"), which borrows the FROM
  // keyword for a column. CTE aliases (f, base, arcs, popular) are unquoted.
  for (const m of playHistory.matchAll(/(?:FROM|JOIN|UPDATE|INTO)\s+"([A-Z]\w*)"/g)) referenced.add(m[1]);

  // The aggregate layer touches exactly these two physical tables; everything
  // else in the module goes through the ORM. Naming them is a stronger
  // non-vacuity guard than a bare count.
  for (const expected of ["PlayHistory", "MediaServerUser"]) {
    assert.ok(referenced.has(expected), `the scan no longer finds "${expected}" in play-history.ts's raw SQL — it is broken`);
  }
  const missing = [...referenced].filter((t) => !models.has(t));
  assert.deepEqual(
    missing,
    [],
    `play-history.ts's raw SQL references table(s) that are not models in schema.prisma: ${missing.join(", ")}`,
  );
});

// ── guardrail 37: the second Jellyfin item id column ────────────────────────
//
// One title can sit in several libraries on ONE server (Anime vs TV, HD vs 4K,
// an accidental double-import) and each copy carries its own Jellyfin item id,
// but @@id([tmdbId, mediaType, serverInstance]) allows exactly one row. Before
// jellyfinItemIds the losing copies' ids were simply lost, so a watch filed
// under one resolved to no title and the episodes filed under it vanished from
// TVEpisodeCache. Dropping this column back out is a `db push` away and nothing
// else in the tree would fail.

// db-export's escapeSQL decides between a Postgres ARRAY literal ('{a,b}') and
// a JSON literal ('["a","b"]') by asking Array.isArray(value) — it has no
// column type at hand. Prisma hands back a JS array for BOTH a scalar-list
// column and a Json column holding a top-level array, so that discriminator is
// only sound while no Json column stores one.
//
// It is not a hypothetical. Emitting the JSON form for the one real scalar list
// (JellyfinLibraryItem.jellyfinItemIds) made Postgres reject the row with
// `22P02 malformed array literal` — the EMPTY array included, so every row of
// that table — and the importer runs the whole dump in one transaction, so the
// first one rolled back the entire restore behind a 200 OK export. A Json
// column holding an array would be the same failure in the other direction: an
// array literal written into jsonb.
//
// So this pin is the standing condition for that shortcut. If it goes red,
// escapeSQL must be taught the real column type instead.
test("no Json column may hold a top-level array — db-export discriminates array columns by JS shape", () => {
  const jsonFields: string[] = [];
  for (const m of models.values()) {
    for (const line of m.body.split("\n")) {
      const match = /^\s*(\w+)\s+Json\b/.exec(line);
      if (match) jsonFields.push(`${m.name}.${match[1]}`);
    }
  }
  // A vacuous pass would be worse than no pin — it must actually find them.
  assert.ok(jsonFields.length > 0, "found no Json columns at all; the schema walk is broken, not the invariant");

  // Every writer must type the value as an object. A `Json` column whose TS
  // type permits an array is the thing that breaks escapeSQL.
  const KNOWN_OBJECT_VALUED = new Set([
    "User.instanceGrants",
    "User.mediaServerGrants",
    "TrashSpec.payload",
  ]);
  for (const field of jsonFields) {
    assert.ok(
      KNOWN_OBJECT_VALUED.has(field),
      `${field} is a new Json column. If it can hold a TOP-LEVEL ARRAY, db-export will emit a Postgres ` +
        `array literal for it and the restore fails with 22P02. Confirm it only ever holds an object, then ` +
        `add it here — or make escapeSQL type-aware.`,
    );
  }
});

test("guardrail 37: JellyfinLibraryItem keeps jellyfinItemIds alongside jellyfinItemId, defaulted so db push can add it to a populated table", () => {
  const m = model("JellyfinLibraryItem");
  assert.ok(m.fields.includes("jellyfinItemId"), "the single canonical id column must stay — every read ORs against it for rows predating the array");
  assert.ok(m.fields.includes("jellyfinItemIds"), "JellyfinLibraryItem is missing jellyfinItemIds; duplicate-library copies become unresolvable again");

  const decl = m.body.split("\n").find((l) => /^\s*jellyfinItemIds\s/.test(l)) ?? "";
  assert.match(decl, /String\[\]/, `jellyfinItemIds must be a String[] — got: ${decl.trim()}`);
  assert.match(
    decl,
    /@default\(\[\]\)/,
    "jellyfinItemIds must @default([]) — a list column with no default cannot be added to a populated table, " +
      "and the entrypoint applies schema changes with db push at boot",
  );

  assert.ok(
    /@@index\(\[jellyfinItemIds\][^)]*type:\s*Gin/.test(m.body),
    "jellyfinItemIds needs a GIN index: the 5s play-history poller ORs a has/hasSome over it on every tick, " +
      "and a btree cannot serve an array containment operator — the query degrades to a full scan of the library",
  );
});

// ── index hygiene: no @@index that a sibling key already serves ─────────────
//
// A Postgres btree answers any query on a LEADING-column prefix of its key, so
// an @@index whose column list is a prefix of another btree key on the same
// model (an @@id, an @@unique, or a wider @@index) adds nothing the planner can
// use — it only adds a btree write per row and its share of vacuum/bloat. Seven
// such indexes shipped from the initial squash: TVEpisodeCache [source, tmdbId]
// under its PK (rewritten wholesale on every hourly sync, so that one was a full
// btree rebuild per run), AuditLog [action] and [userId] under their
// [_, createdAt desc] composites, a bare [source] on PlayHistory,
// ActiveSession and MediaServerUser under their [source, serverInstance]
// composites, and PlayHistory's [source, sourceSessionId] under the dedup
// unique (pinned by name above). All were dropped; `db push` applies that as a
// plain DROP INDEX with no data-loss prompt, so the entrypoint's auto-safe
// classifier is not involved.
//
// GIN indexes are exempt in both directions: a GIN over an array column serves
// containment operators no btree can, and no btree serves what it does.

/** [model, index columns] pairs that are prefix-redundant but deliberately still present. */
const KNOWN_PREFIX_REDUNDANT_INDEXES = new Set([
  // Same shape as the seven that were dropped — a [a, b] @@index sitting under a
  // [a, b, c] @@unique on the same model. Left in place pending their own review
  // rather than removed on the strength of a structural argument alone; delete
  // the entry here when the index goes.
  "DeletionVote:[tmdbId,mediaType]",
  "TrashSpec:[service,kind]",
  "MediaServerUser:[source,serverInstance]",
  "PlayHistory:[source,serverInstance]",
  "ActiveSession:[source,serverInstance]",
]);

test("no @@index is a leading-column prefix of another btree key on the same model", () => {
  const offenders: string[] = [];
  let compared = 0;
  for (const m of models.values()) {
    const btreeKeys: { label: string; cols: string[] }[] = [
      ...m.keys.map((k) => ({ label: `@@${k.kind}([${k.cols.join(", ")}])`, cols: k.cols })),
      ...m.indexes.filter((ix) => !ix.gin).map((ix) => ({ label: `@@index([${ix.cols.join(", ")}])`, cols: ix.cols })),
    ];
    for (const ix of m.indexes) {
      if (ix.gin) continue;
      for (const other of btreeKeys) {
        if (other.cols === ix.cols) continue; // itself
        compared += 1;
        const isPrefix = other.cols.length >= ix.cols.length && ix.cols.every((c, i) => c === other.cols[i]);
        if (!isPrefix) continue;
        const tag = `${m.name}:[${ix.cols.join(",")}]`;
        if (KNOWN_PREFIX_REDUNDANT_INDEXES.has(tag)) continue;
        offenders.push(`${m.name} @@index([${ix.cols.join(", ")}]) is a prefix of ${other.label}`);
      }
    }
  }
  assert.ok(compared > 50, `only ${compared} index/key comparisons were made — the schema walk is broken, not the invariant`);
  assert.deepEqual(
    offenders,
    [],
    "each listed @@index is fully served by the wider key beside it and only adds a btree write per row. " +
      "Drop it (db push emits a plain DROP INDEX) — or, if a reader genuinely needs it, add it to " +
      "KNOWN_PREFIX_REDUNDANT_INDEXES with the reason.",
  );
});

test("KNOWN_PREFIX_REDUNDANT_INDEXES carries no stale entries", () => {
  // An allowlist entry that no longer matches a real index is either a typo
  // (the pin silently stopped guarding what it names) or a cleanup that forgot
  // to remove its own exemption. Either way it must go red.
  const present = new Set<string>();
  for (const m of models.values()) for (const ix of m.indexes) present.add(`${m.name}:[${ix.cols.join(",")}]`);
  const stale = [...KNOWN_PREFIX_REDUNDANT_INDEXES].filter((tag) => !present.has(tag));
  assert.deepEqual(stale, [], `allowlisted index(es) no longer exist in schema.prisma — remove the entry: ${stale.join(", ")}`);
});

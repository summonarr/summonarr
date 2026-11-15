// The title-key checker shared by the admin blacklist and cleanup-protection routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { parseTitleKeyBody, parseTitleKeyQuery } from "../src/lib/title-key-input.ts";

const t = ((key: string) => key) as never;
const errorOf = async (r: unknown) => {
  assert.ok(r instanceof NextResponse);
  assert.equal(r.status, 400);
  return (await r.json()).error as string;
};

test("a valid body comes back as its fields, with title and reason optional", () => {
  assert.deepEqual(parseTitleKeyBody({ tmdbId: 603, mediaType: "MOVIE" }, t), { tmdbId: 603, mediaType: "MOVIE", title: undefined, reason: undefined });
  assert.deepEqual(parseTitleKeyBody({ tmdbId: 1, mediaType: "TV", title: "x", reason: "y" }, t), { tmdbId: 1, mediaType: "TV", title: "x", reason: "y" });
});

test("each bad body field gets its own 400", async () => {
  assert.equal(await errorOf(parseTitleKeyBody({ tmdbId: "1", mediaType: "MOVIE" }, t)), "apiAdmin.common.tmdbIdPositive");
  assert.equal(await errorOf(parseTitleKeyBody({ tmdbId: 2 ** 31, mediaType: "MOVIE" }, t)), "apiAdmin.common.tmdbIdPositive");
  assert.equal(await errorOf(parseTitleKeyBody({ tmdbId: 1, mediaType: "movie" }, t)), "apiAdmin.common.mediaTypeMovieOrTv");
  assert.equal(await errorOf(parseTitleKeyBody({ tmdbId: 1, mediaType: "TV", title: "x".repeat(501) }, t)), "apiAdmin.common.titleTooLong");
  assert.equal(await errorOf(parseTitleKeyBody({ tmdbId: 1, mediaType: "TV", reason: 5 }, t)), "apiAdmin.common.reasonTooLong");
});

test("the query form reads the same key and refuses a missing or invalid one", async () => {
  assert.deepEqual(parseTitleKeyQuery(new URLSearchParams("tmdbId=5&mediaType=TV"), t), { tmdbId: 5, mediaType: "TV" });
  assert.equal(await errorOf(parseTitleKeyQuery(new URLSearchParams("mediaType=TV"), t)), "apiAdmin.common.tmdbIdAndMediaTypeRequired");
  assert.equal(await errorOf(parseTitleKeyQuery(new URLSearchParams("tmdbId=5&mediaType=X"), t)), "apiAdmin.common.tmdbIdAndMediaTypeRequired");
});

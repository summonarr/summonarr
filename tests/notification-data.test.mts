// Unit tests for the in-app notification row shaper (src/lib/notification-data.ts).
// Pure leaf — the single source of field-mapping shared by createInAppNotification
// (single create) and the request-notifications batch createMany.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNotificationData } from "../src/lib/notification-data.ts";

test("carries through the base fields with the given userId", () => {
  const row = buildNotificationData("user-1", {
    type: "REQUEST_APPROVED",
    title: "Inception",
    body: "Your movie request was approved and is downloading.",
    tmdbId: 27205,
    mediaType: "MOVIE",
    posterPath: "/poster.jpg",
  });
  assert.equal(row.userId, "user-1");
  assert.equal(row.type, "REQUEST_APPROVED");
  assert.equal(row.title, "Inception");
  assert.equal(row.body, "Your movie request was approved and is downloading.");
  assert.equal(row.tmdbId, 27205);
  assert.equal(row.mediaType, "MOVIE");
  assert.equal(row.posterPath, "/poster.jpg");
});

test("mediaType normalizes to the MOVIE/TV enum or null", () => {
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b", mediaType: "MOVIE" }).mediaType, "MOVIE");
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b", mediaType: "TV" }).mediaType, "TV");
  // Anything else (garbage, lowercase, undefined, null) collapses to null so the
  // insert never violates the MediaType enum column.
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b", mediaType: "movie" }).mediaType, null);
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b", mediaType: "PERSON" }).mediaType, null);
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b", mediaType: null }).mediaType, null);
  assert.equal(buildNotificationData("u", { type: "T", title: "a", body: "b" }).mediaType, null);
});

test("title/body are capped to the VarChar(500)/VarChar(1000) column widths", () => {
  const longTitle = "x".repeat(600);
  const longBody = "y".repeat(1200);
  const row = buildNotificationData("u", { type: "ISSUE_REPLY", title: longTitle, body: longBody });
  assert.equal(row.title.length, 500);
  assert.equal(row.body.length, 1000);
});

test("optional tmdbId/posterPath default to null", () => {
  const row = buildNotificationData("u", { type: "ISSUE_RESOLVED", title: "a", body: "b" });
  assert.equal(row.tmdbId, null);
  assert.equal(row.posterPath, null);
});

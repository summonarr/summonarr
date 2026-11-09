// The chunked backup upload's headers (src/lib/upload-chunk-headers.ts): an
// absent or malformed header is refused, never read as 0 — a request with no
// X-Chunk-Index used to count as chunk 0 and restart the upload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUploadChunkHeaders } from "../src/lib/upload-chunk-headers.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const headers = (over: Record<string, string | null> = {}) => {
  const h = new Headers({ "x-upload-id": ID, "x-chunk-index": "0", "x-chunk-total": "4", "x-file-size": "4096" });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return h;
};

test("well-formed headers parse to whole numbers", () => {
  assert.deepEqual(parseUploadChunkHeaders(headers({ "x-chunk-index": "3" })), { uploadId: ID, chunkIndex: 3, chunkTotal: 4, fileSize: 4096 });
});

test("a missing header is refused, never read as 0", () => {
  for (const name of ["x-chunk-index", "x-chunk-total", "x-file-size", "x-upload-id"]) {
    assert.equal(parseUploadChunkHeaders(headers({ [name]: null })), null, name);
    assert.equal(parseUploadChunkHeaders(headers({ [name]: "" })), null, `${name} empty`);
  }
});

test("a negative, fractional, exponent or out-of-range number is refused", () => {
  for (const bad of ["-1", "1.5", "1e3", "0x10", "2a", "99999999999999999"]) {
    assert.equal(parseUploadChunkHeaders(headers({ "x-chunk-index": bad })), null, bad);
  }
  assert.equal(parseUploadChunkHeaders(headers({ "x-chunk-total": "0" })), null, "an upload has at least one chunk");
  assert.equal(parseUploadChunkHeaders(headers({ "x-file-size": "0" })), null, "an upload has at least one byte");
});

test("an index past the total is left to the session to judge", () => {
  assert.equal(parseUploadChunkHeaders(headers({ "x-chunk-index": "9" }))?.chunkIndex, 9);
});

test("parseUploadChunkHeaders refuses an oversized upload id", () => {
  const h = new Headers({ "x-upload-id": "a".repeat(129), "x-chunk-index": "0", "x-chunk-total": "1", "x-file-size": "10" });
  assert.equal(parseUploadChunkHeaders(h), null);
});

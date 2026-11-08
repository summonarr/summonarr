// The push registration routes' field parsers (src/lib/push-body.ts). The
// routes' own suite (tests/push-routes.test.mts) drives them through HTTP; these
// pin the edge cases one rule at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";

const {
  parseApnsDeviceToken,
  parsePushLabel,
  parseApnsPublicKey,
  checkWebPushEndpoint,
  canonicalizePushEndpoint,
} = await import("../src/lib/push-body.ts");

test("an APNs device token is trimmed and lowercased; anything but whole bytes of hex is refused", () => {
  assert.equal(parseApnsDeviceToken(`  ${"AB".repeat(32)} `), "ab".repeat(32));
  for (const raw of ["abc", "ab".repeat(31), "zz".repeat(32), "ab".repeat(101), 123, null, undefined, { token: "ab".repeat(32) }]) {
    assert.equal(parseApnsDeviceToken(raw), null, JSON.stringify(raw));
  }
});

test("a label is sanitized and bounded; a non-string or an empty result leaves the stored label alone", () => {
  assert.equal(parsePushLabel("My ‮phone<>"), "My phone");
  assert.equal(parsePushLabel("x".repeat(300))?.length, 100);
  for (const raw of [123, null, undefined, "", "<>"]) assert.equal(parsePushLabel(raw), undefined, JSON.stringify(raw));
});

test("the E2E public key: a valid point is set, an explicit null clears, absent or malformed keeps the stored key", () => {
  const key = Buffer.from(createECDH("prime256v1").generateKeys()).toString("base64");
  assert.deepEqual(parseApnsPublicKey(key), { kind: "set", value: key });
  assert.deepEqual(parseApnsPublicKey(null), { kind: "set", value: null });
  for (const raw of [undefined, "", "bm90IGEga2V5", 42, "A".repeat(200)]) {
    assert.deepEqual(parseApnsPublicKey(raw), { kind: "keep" }, JSON.stringify(raw));
  }
});

test("a Web Push endpoint must be https on a known push service", () => {
  assert.equal(checkWebPushEndpoint("https://fcm.googleapis.com/fcm/send/x"), "ok");
  assert.equal(checkWebPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x"), "ok");
  assert.equal(checkWebPushEndpoint("https://web.push.apple.com/abc"), "ok");
  assert.equal(checkWebPushEndpoint("http://fcm.googleapis.com/fcm/send/x"), "not-https");
  assert.equal(checkWebPushEndpoint("https://evil.example/fcm.googleapis.com"), "unrecognized");
  assert.equal(checkWebPushEndpoint("https://notify.windows.com.evil.example/x"), "unrecognized");
  assert.equal(checkWebPushEndpoint("not a url"), "invalid-url");
});

test("an endpoint's stored key collapses only the bare-origin trailing slash", () => {
  assert.equal(canonicalizePushEndpoint("https://fcm.googleapis.com/"), "https://fcm.googleapis.com");
  assert.equal(canonicalizePushEndpoint("https://fcm.googleapis.com/fcm/send/x/"), "https://fcm.googleapis.com/fcm/send/x/");
  assert.equal(canonicalizePushEndpoint("HTTPS://FCM.googleapis.com/a"), "https://fcm.googleapis.com/a");
  assert.equal(canonicalizePushEndpoint("ftp://fcm.googleapis.com/a"), null);
  assert.equal(canonicalizePushEndpoint("nope"), null);
});

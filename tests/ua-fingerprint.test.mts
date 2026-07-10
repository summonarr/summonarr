// Unit tests for UA fingerprinting (src/lib/ua-fingerprint.ts). The fingerprint
// binds a cookie session to browser-family/OS/device-class, so the classifier's
// precedence rules (Edge/Opera before Chrome, iPad-as-tablet) and the skip rules
// in matchesStoredFingerprint (machine: prefix, absent fingerprint) are the
// security-relevant surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractUaFingerprint,
  serializeFingerprint,
  matchesStoredFingerprint,
  fingerprintToLabel,
} from "../src/lib/ua-fingerprint.ts";

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  operaMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  chromeAndroidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  chromeAndroidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  firefoxMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  yandexWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 YaBrowser/24.1.0.0 Safari/537.36",
  ie11Win:
    "Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
};

test("desktop browser/OS classification", () => {
  assert.deepEqual(extractUaFingerprint(UA.chromeWin), { browser: "chrome", os: "windows", device: "desktop" });
  assert.deepEqual(extractUaFingerprint(UA.firefoxMac), { browser: "firefox", os: "macos", device: "desktop" });
});

test("Chromium derivatives win over Chrome (their UAs also contain Chrome/)", () => {
  assert.equal(extractUaFingerprint(UA.edgeWin).browser, "edge");
  assert.equal(extractUaFingerprint(UA.operaMac).browser, "opera");
});

test("mobile vs tablet: iPhone is mobile, iPad is tablet, Android splits on Mobile token", () => {
  assert.deepEqual(extractUaFingerprint(UA.safariIphone), { browser: "safari", os: "ios", device: "mobile" });
  assert.deepEqual(extractUaFingerprint(UA.safariIpad), { browser: "safari", os: "ios", device: "tablet" });
  assert.equal(extractUaFingerprint(UA.chromeAndroidPhone).device, "mobile");
  assert.equal(extractUaFingerprint(UA.chromeAndroidTablet).device, "tablet");
});

test("empty/garbage UA degrades to unknown desktop, never throws", () => {
  assert.deepEqual(extractUaFingerprint(""), { browser: "unknown", os: "unknown", device: "desktop" });
  assert.deepEqual(extractUaFingerprint("curl/8.4.0"), { browser: "unknown", os: "unknown", device: "desktop" });
});

test("serializeFingerprint is the browser:os:device triple", () => {
  assert.equal(serializeFingerprint(extractUaFingerprint(UA.chromeWin)), "chrome:windows:desktop");
});

test("matchesStoredFingerprint: match / mismatch / skip rules", () => {
  const stored = serializeFingerprint(extractUaFingerprint(UA.chromeWin));
  // Same browser family matches even across versions (fingerprint has no version).
  assert.equal(matchesStoredFingerprint(stored, UA.chromeWin.replace("120.0.0.0", "121.0.0.0")), true);
  // Different browser family on the same OS is a mismatch → deny.
  assert.equal(matchesStoredFingerprint(stored, UA.edgeWin), false);
  // A null UA cannot match a real stored fingerprint.
  assert.equal(matchesStoredFingerprint(stored, null), false);
  // No fingerprint on the claims → skip (older tokens must keep working).
  assert.equal(matchesStoredFingerprint(undefined, UA.chromeWin), true);
  assert.equal(matchesStoredFingerprint("", UA.chromeWin), true);
  // machine: sessions are bound to CRON_SECRET, not a UA → always skip.
  assert.equal(matchesStoredFingerprint("machine:abc123", null), true);
});

test("fingerprintToLabel renders device-aware OS names", () => {
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.safariIpad)), "Safari on iPad");
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.safariIphone)), "Safari on iPhone");
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.chromeWin)), "Chrome on Windows");
  assert.equal(fingerprintToLabel(extractUaFingerprint("")), "Unknown Browser on Unknown OS");
});

test("Samsung Internet and Yandex win over Chrome (their UAs also contain Chrome/)", () => {
  // Same regression class as Edge/Opera: both UAs carry a Chrome/ token, so
  // moving the Chrome/ test above them in the ternary would misclassify both.
  assert.deepEqual(extractUaFingerprint(UA.samsungAndroid), {
    browser: "samsung",
    os: "android",
    device: "mobile",
  });
  assert.deepEqual(extractUaFingerprint(UA.yandexWin), {
    browser: "yandex",
    os: "windows",
    device: "desktop",
  });
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.samsungAndroid)), "Samsung Internet on Android");
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.yandexWin)), "Yandex Browser on Windows");
});

test("IE11 classifies via the Trident/ alternation (no MSIE token in its UA)", () => {
  assert.deepEqual(extractUaFingerprint(UA.ie11Win), {
    browser: "ie",
    os: "windows",
    device: "desktop",
  });
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.ie11Win)), "Internet Explorer on Windows");
});

test("Chrome OS (CrOS token) classifies as chromeos, not linux/unknown", () => {
  assert.deepEqual(extractUaFingerprint(UA.chromeOs), {
    browser: "chrome",
    os: "chromeos",
    device: "desktop",
  });
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.chromeOs)), "Chrome on Chrome OS");
});

test("iOS Chrome (CriOS/) classifies as safari — pins CURRENT behavior", () => {
  // Chrome on iOS sends CriOS/ instead of Chrome/, so it falls through to the
  // Safari/ test. This is intentionally pinned: "fixing" the classification to
  // "chrome" would change serializeFingerprint output and invalidate every
  // stored fingerprint for iOS Chrome users, forcing them all to re-login.
  assert.deepEqual(extractUaFingerprint(UA.chromeIphone), {
    browser: "safari",
    os: "ios",
    device: "mobile",
  });
  // And the stored fingerprint keeps matching across requests from that browser.
  const stored = serializeFingerprint(extractUaFingerprint(UA.chromeIphone));
  assert.equal(matchesStoredFingerprint(stored, UA.chromeIphone), true);
});

test("fingerprintToLabel splits Android tablet vs phone", () => {
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.chromeAndroidTablet)), "Chrome on Android Tablet");
  assert.equal(fingerprintToLabel(extractUaFingerprint(UA.chromeAndroidPhone)), "Chrome on Android");
});

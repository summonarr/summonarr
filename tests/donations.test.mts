// Unit tests for the donation-link gate (src/lib/donations.ts). The /donate
// page, the nav link, and the public config endpoint all key off the same
// DONATION_SETTING_KEYS list + hasDonationLinks predicate — if the key list or
// the "non-empty after trim" rule drifts, the Donate surface either shows with
// nothing to link to or silently disappears while methods are configured.
// (hasConfiguredDonationLinks is DB-backed and is intentionally not covered.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DONATION_SETTING_KEYS, hasDonationLinks } from "../src/lib/donations.ts";

// The donations module imports @/lib/prisma; env reads there are lazy, but set
// the required vars anyway so an incidental lazy read can never throw mid-test.
process.env.NEXTAUTH_SECRET = "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

test("DONATION_SETTING_KEYS pins the exact shared key list", () => {
  // Order matters only insofar as the /donate page renders methods from this
  // array — an exact match catches accidental adds/removes/renames.
  assert.deepEqual(
    [...DONATION_SETTING_KEYS],
    [
      "donationPaypal",
      "donationVenmo",
      "donationZelle",
      "donationAmazon",
      "donationPatreon",
      "donationBuyMeACoffee",
    ],
  );
});

test("empty cfg map → false", () => {
  assert.equal(hasDonationLinks({}), false);
});

test("all keys present but empty/null/undefined → false", () => {
  assert.equal(
    hasDonationLinks({
      donationPaypal: "",
      donationVenmo: null,
      donationZelle: undefined,
      donationAmazon: "",
      donationPatreon: null,
      donationBuyMeACoffee: "",
    }),
    false,
  );
});

test("whitespace-only values do not count as configured (trim rule)", () => {
  assert.equal(
    hasDonationLinks({
      donationPaypal: "   ",
      donationVenmo: "\t",
      donationZelle: "\n\n",
      donationBuyMeACoffee: " \r\n ",
    }),
    false,
  );
});

test("each donation key alone flips the gate to true", () => {
  for (const key of DONATION_SETTING_KEYS) {
    assert.equal(hasDonationLinks({ [key]: "https://example.com/donate" }), true, key);
  }
});

test("a value with surrounding whitespace but real content counts", () => {
  assert.equal(hasDonationLinks({ donationVenmo: "  @summonarr  " }), true);
});

test("non-donation keys never open the gate", () => {
  assert.equal(
    hasDonationLinks({
      radarrUrl: "http://radarr:7878",
      donationBitcoin: "bc1qexample", // not in the supported list
      featureDonate: "true",
    }),
    false,
  );
});

test("key matching is case-sensitive — a wrong-cased key does not count", () => {
  assert.equal(hasDonationLinks({ DonationPaypal: "https://paypal.me/x" }), false);
  assert.equal(hasDonationLinks({ donationpaypal: "https://paypal.me/x" }), false);
});

test("one configured method among otherwise-blank keys is enough", () => {
  assert.equal(
    hasDonationLinks({
      donationPaypal: "",
      donationVenmo: "   ",
      donationZelle: null,
      donationAmazon: "https://amazon.com/hz/wishlist/ls/XYZ",
      donationPatreon: undefined,
      donationBuyMeACoffee: "",
    }),
    true,
  );
});

// Shared notification label helpers (src/lib/notify-i18n.ts): how an enum or
// catalog label is written when it lands MID-SENTENCE in an email, push or
// Discord message.
//
// Pinned because the casing rule differs per language for a reason:
//   - every language but German lowercases an inline label ("a new movie
//     request", "una nueva solicitud (película)"), and English is byte-identical
//     to the pre-i18n output — "tv show", acronym and all;
//   - German keeps its nouns capitalized ("Film", "Serie" pass through), and an
//     ALL-CAPS German catalog label (the issue types mirror English's historical
//     "BAD VIDEO" shape) is title-cased per word rather than shouted or stripped
//     of its capitals: "Schlechtes Video", never "SCHLECHTES VIDEO" (what the
//     bare pass-through produced) and never "schlechtes video".
// The catalog values are read through the real German translator, so a
// re-worded catalog is caught here rather than silently re-shouting.
import { test } from "node:test";
import assert from "node:assert/strict";

const { inlineLabel, issueTypeLabelT, mediaLabelT } = await import("../src/lib/notify-i18n.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

test("German: an all-caps catalog label is title-cased per word (real de catalog)", () => {
  const t = translatorFor("de");
  assert.equal(t("notify.issueType.BAD_VIDEO"), "SCHLECHTES VIDEO", "the catalog shape this rule exists for");
  assert.equal(inlineLabel(issueTypeLabelT(t, "BAD_VIDEO"), "de"), "Schlechtes Video");
  assert.equal(inlineLabel(issueTypeLabelT(t, "WRONG_AUDIO"), "de"), "Falsche Tonspur");
  assert.equal(inlineLabel(issueTypeLabelT(t, "MISSING_SUBTITLES"), "de"), "Fehlende Untertitel");
  assert.equal(inlineLabel(issueTypeLabelT(t, "WRONG_MATCH"), "de"), "Falsche Zuordnung");
  assert.equal(inlineLabel(issueTypeLabelT(t, "OTHER"), "de"), "Sonstiges");
  assert.equal(inlineLabel("FILM-ANFRAGE", "de"), "Film-Anfrage", "a hyphenated part is a word");
});

test("German: a mixed-case label keeps its noun capital untouched", () => {
  const t = translatorFor("de");
  assert.equal(inlineLabel(mediaLabelT(t, "MOVIE"), "de"), "Film");
  assert.equal(inlineLabel(mediaLabelT(t, "TV"), "de"), "Serie");
  assert.equal(inlineLabel("Film-Anfrage", "de"), "Film-Anfrage");
  assert.equal(inlineLabel("", "de"), "", "an empty label is neither shouted nor title-cased");
});

test("every other language lowercases an inline label; English is byte-identical to the pre-i18n output", () => {
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("en"), "BAD_VIDEO"), "en"), "bad video");
  assert.equal(inlineLabel(mediaLabelT(translatorFor("en"), "TV"), "en"), "tv show");
  assert.equal(inlineLabel(mediaLabelT(translatorFor("es"), "MOVIE"), "es"), "película");
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("fr"), "BAD_VIDEO"), "fr"), "vidéo défectueuse");
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("pt"), "WRONG_AUDIO"), "pt"), "áudio errado");
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("zh"), "BAD_VIDEO"), "zh"), "画质差");
});

test("an unknown issue type keeps the enum derivation (casing untouched), then follows the same inline rule", () => {
  assert.equal(issueTypeLabelT(translatorFor("de"), "PLAYBACK_STUTTER"), "PLAYBACK STUTTER");
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("de"), "PLAYBACK_STUTTER"), "de"), "Playback Stutter");
  assert.equal(inlineLabel(issueTypeLabelT(translatorFor("en"), "PLAYBACK_STUTTER"), "en"), "playback stutter");
});

// Shared label helpers for notification text (email, push, Discord). Every
// notification is written in its RECIPIENT's language — the caller resolves a
// Translator with translatorForUser(user) (or translatorFor(instanceDefaultLocale())
// for a shared channel) and these turn enum values into words in that language.
// Keys live in messages/<locale>/notify.json; the English values are the exact
// strings these notifications always carried, so a recipient with no stored
// locale (and no SUMMONARR_DEFAULT_LOCALE) gets byte-identical English.

import type { Translator } from "./i18n/translate";

// A label dropped mid-sentence ("a new movie request") is lowercased — except
// in German, where nouns stay capitalized ("eine neue Film-Anfrage", not "film").
export function inlineLabel(label: string, locale: string): string {
  return locale === "de" ? label : label.toLocaleLowerCase(locale);
}

export function mediaLabelT(t: Translator, mediaType: string): string {
  return mediaType === "MOVIE" ? t("notify.media.movie") : t("notify.media.tv");
}

const ISSUE_TYPES = new Set(["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"]);

// Issue label used by email and push. English keeps the historical derivation
// from the enum (underscores → spaces, casing untouched: "WRONG AUDIO"); an
// unknown type still goes through that derivation.
export function issueTypeLabelT(t: Translator, issueType: string): string {
  if (ISSUE_TYPES.has(issueType)) return t(`notify.issueType.${issueType}`);
  return issueType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Sentence-cased issue label ("Bad video") used by the Discord admin embed. An
// unknown type is shown raw, as before.
export function discordIssueTypeLabelT(t: Translator, issueType: string): string {
  if (ISSUE_TYPES.has(issueType)) return t(`notify.discord.issueType.${issueType}`);
  return issueType;
}

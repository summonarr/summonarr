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
// The ISSUE-TYPE labels are ALL CAPS in every catalog (English's historical
// "BAD VIDEO" shape, which the other languages lowercase to "mala calidad de
// vídeo"); passing one through made German the only language whose preheader
// shouted "(SCHLECHTES VIDEO)", while lowercasing it would strip the nouns.
// So an all-caps German label is title-cased per word ("Schlechtes Video",
// "Falsche Tonspur") and a mixed-case one ("Film", "Serie") passes through.
// English stays byte-identical to the pre-i18n output ("tv show").
export function inlineLabel(label: string, locale: string): string {
  if (locale !== "de") return label.toLocaleLowerCase(locale);
  return isAllCaps(label, locale) ? titleCaseWords(label, locale) : label;
}

// At least one cased letter, none of them lowercase.
function isAllCaps(s: string, locale: string): boolean {
  return s !== s.toLocaleLowerCase(locale) && s === s.toLocaleUpperCase(locale);
}

// Each word's first letter up, the rest down; a hyphenated part counts as a
// word ("FEHLENDE UNTERTITEL" → "Fehlende Untertitel").
function titleCaseWords(s: string, locale: string): string {
  return s
    .toLocaleLowerCase(locale)
    .replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toLocaleUpperCase(locale));
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

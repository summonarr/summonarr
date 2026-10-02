import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { isLocale } from "@/lib/i18n/locales";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// PATCH { locale } — remember the caller's UI language on their account, so
// emails, push notifications and Discord DMs (which have no browser cookie to
// read) are written in it. The web language picker calls this; so does the
// one-time sync in LocaleSync for an account that has never stored one.
export const PATCH = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ locale?: unknown }>(req, 1024);
  if (parsed instanceof NextResponse) return parsed;
  if (!isLocale(parsed.locale)) {
    return NextResponse.json({ error: t("apiAuth.profile.unsupportedLocale") }, { status: 400 });
  }
  await prisma.user.update({ where: { id: session.user.id }, data: { locale: parsed.locale } });
  return NextResponse.json({ locale: parsed.locale });
});

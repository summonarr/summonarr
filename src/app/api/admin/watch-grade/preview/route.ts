import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { WATCH_GRADE_SETTING_KEYS, watchGradeCrossFieldError, watchGradeSettingError } from "@/lib/watch-grade";
import { mergedWatchGradeSettings, previewWatchGradeSpread } from "@/lib/watch-grade-data";

export const dynamic = "force-dynamic";

// How the grade spread across users would change with the watch-grade settings
// in the body — the Settings → Watch Grades preview. Nothing is written.
//
// The body is judged exactly as a save of the same form would be: the same
// per-key bounds and cross-field rules, and the same merge (a key left out keeps
// its stored value, a blank one means the default). An answer for values the
// save would refuse would be a preview of something that can't happen.
//
// ADMIN only, like /api/settings: this is the settings form's companion, and it
// grades every requester twice, so it isn't something to hand out wider.
export const POST = withAdmin(async (req) => {
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16_384);
  if (parsed instanceof NextResponse) return parsed;
  if (Array.isArray(parsed)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  for (const key of Object.values(WATCH_GRADE_SETTING_KEYS)) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return NextResponse.json({ error: `Setting "${key}" must be a string` }, { status: 400 });
    }
    if (value.trim() === "") continue;
    const error = watchGradeSettingError(key, value.trim());
    if (error) return NextResponse.json({ error }, { status: 400 });
  }

  const proposed = await mergedWatchGradeSettings(parsed);
  const conflict = watchGradeCrossFieldError(proposed);
  if (conflict) return NextResponse.json({ error: conflict }, { status: 400 });

  return NextResponse.json(await previewWatchGradeSpread(proposed));
});

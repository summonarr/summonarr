import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { readArrCommands } from "@/lib/arr-admin";
import { arrFailure, arrGate } from "@/lib/arr-admin-http";
import { COMMAND_READ_MAX_IDS } from "@/lib/arr-command-status";
import { parseIdList } from "@/lib/arr-history";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import { forgetWarnOnChange } from "@/lib/log-dedup";
import { checkRateLimit } from "@/lib/rate-limit";

// The watch's own chunk size (one constant for both): above anything a
// starting route queues — Sonarr "search missing" is one SeasonSearch per fully
// missing season, uncapped — and the watch splits a longer list across reads.
const MAX_IDS = COMMAND_READ_MAX_IDS;
// The status line polls every 2 s per command it follows, and a page can
// follow a few at once (Arr System: one per card) — generous, but bounded.
const LIMIT_PER_MIN = 120;
const LIMIT_WINDOW_MS = 60_000;

// The live status of Radarr/Sonarr commands Summonarr started (ADMIN): the
// title manager's searches and refresh, a rename, Arr System's task runs and
// library-wide searches, Clear blocklist. Each of those answers with the arr's
// command id(s); the page polls here until every one has ended.
//   GET ?service&instance&ids=1,2,3 → { commands: [{ id, name, commandName,
//       status, message, queued, started, ended, durationSeconds }] }, one per
//       id, in the order asked — Arr System's explicit field list for a command
//       (projectCommands), message masked, NEVER the command body (guardrail
//       5e). An id the arr answers 404 for is { id, status: "gone" }: it
//       forgets a finished command after a while.
//   At most MAX_IDS ids, positive integers (duplicates collapse); anything
//   else is 400. They are read a few at a time (readArrCommands), and the
//   first failure stops the rest. Read-only, not audited; rate-limited per
//   admin for polling.
export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const ids = parseIdList(q.get("ids"), MAX_IDS);
  if (!ids) return NextResponse.json({ error: t("apiAdmin.arr.commandIdsInvalid", { max: MAX_IDS }) }, { status: 400 });
  if (!checkRateLimit(`arr-commands:${session.user.id}`, LIMIT_PER_MIN, LIMIT_WINDOW_MS)) {
    return tooManyRequests(LIMIT_WINDOW_MS / 1000, t("apiAdmin.common.tooManyRequestsLater"));
  }
  // One unchanged failure across polls is logged once (guardrail 7b).
  const warnKey = `arr-commands:${target.service}:${target.instance}`;
  try {
    const commands = await readArrCommands(target.service, target.instance, ids);
    forgetWarnOnChange(warnKey);
    return NextResponse.json({ commands });
  } catch (err) {
    return arrFailure(err, target, t, "command status read", { warnKey });
  }
});

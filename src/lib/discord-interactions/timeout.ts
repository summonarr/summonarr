import type { Translator } from "@/lib/i18n/translate";
import { editOriginal, editsIdle } from "./reply";

export function withDiscordTimeout(
  fn: () => Promise<void>,
  appId: string,
  token: string,
  t: Translator,
  timeoutMs = 25_000,
): void {
  let settled = false;
  const timer = setTimeout(() => {
    void (async () => {
      // A handler's final edit is its last await, so the timer can fire while
      // that edit is in flight. Let it land, give the handler a turn to finish,
      // and skip the line if it did — sent after the result, it would replace
      // it. Edits of one message go out in call order (editOriginal), so a line
      // sent here still lands before any later final edit.
      await editsIdle(token);
      if (settled) return;
      await editOriginal(appId, token, { content: t("notify.bot.slow") });
    })().catch(() => {});
  }, timeoutMs);

  void fn()
    .catch((err) => {
      // Reported even after the "taking longer" line went out: that line promises
      // a result, and a handler that then fails would otherwise leave it standing.
      console.error("[interactions] handler error:", err);
      void editOriginal(appId, token, {
        content: t("notify.bot.unexpected"),
      }).catch(() => {});
    })
    .finally(() => {
      settled = true;
      clearTimeout(timer);
    });
}

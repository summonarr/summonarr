import type { Translator } from "@/lib/i18n/translate";
import { editOriginal } from "./reply";

export function withDiscordTimeout(
  fn: () => Promise<void>,
  appId: string,
  token: string,
  t: Translator,
  timeoutMs = 25_000,
): void {
  const timer = setTimeout(() => {
    void editOriginal(appId, token, {
      content: t("notify.bot.slow"),
    }).catch(() => {});
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
    .finally(() => clearTimeout(timer));
}

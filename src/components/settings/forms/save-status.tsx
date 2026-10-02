import { CheckCircle, XCircle } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import type { SaveStatus } from "./shared";

// The "Saved" / "Failed to save" line shared by the settings forms. It sits in
// an ARIA live region so screen readers read the result out loud. Success is
// "polite" (read when the reader is free); a failure is "assertive" (read right
// away). Same pattern as create-user-button.tsx. While saving it shows nothing,
// because the Save button already shows its own "Saving…" spinner.
export function SaveStatusMessage({
  status,
  okLabel,
  errorLabel,
}: {
  status: SaveStatus;
  okLabel?: string;
  errorLabel?: string;
}) {
  const t = useT();
  if (status === "ok") {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
        <CheckCircle className="w-4 h-4" />
        {okLabel ?? t("settings.form.common.saved")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
        <XCircle className="w-4 h-4" />
        {errorLabel ?? t("settings.form.common.saveFailed")}
      </span>
    );
  }
  return null;
}

import { CheckCircle, Loader2, XCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
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

// The submit button and result line every plain settings form ends with:
// "Saving…" with a spinner while the request runs, then the live-region result.
// `message` is the route's own reason for a refusal; without one the generic
// "Failed to save" shows. `label` replaces the idle "Save" text.
export function SaveButtonRow({
  status,
  message,
  label,
  disabled,
}: {
  status: SaveStatus;
  message?: string;
  label?: string;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={disabled || status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
        {status === "saving"
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</>
          : label ?? t("settings.form.common.save")}
      </Button>
      <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
    </div>
  );
}

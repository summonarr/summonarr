import { CheckCircle, XCircle } from "@/components/icons";
import type { SaveStatus } from "./shared";

// Shared save-status indicator for the settings forms. Renders the success/
// error line inside an ARIA live region so screen readers announce the outcome
// of a save (previously a bare <span>, silent to AT). Success is polite; a
// failure is assertive so it isn't queued behind other polite updates. Mirrors
// the create-user-button.tsx pattern. `saving` renders nothing here — the Save
// button already shows its own "Saving…" spinner.
export function SaveStatusMessage({
  status,
  okLabel = "Saved",
  errorLabel = "Failed to save",
}: {
  status: SaveStatus;
  okLabel?: string;
  errorLabel?: string;
}) {
  if (status === "ok") {
    return (
      <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-green-400">
        <CheckCircle className="w-4 h-4" />
        {okLabel}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span role="alert" aria-live="assertive" className="flex items-center gap-1.5 text-sm text-red-400">
        <XCircle className="w-4 h-4" />
        {errorLabel}
      </span>
    );
  }
  return null;
}

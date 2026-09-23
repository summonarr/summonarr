import { CheckCircle, XCircle } from "@/components/icons";
import type { SaveStatus } from "./shared";

// The "Saved" / "Failed to save" line shared by the settings forms. It sits in
// an ARIA live region so screen readers read the result out loud. Success is
// "polite" (read when the reader is free); a failure is "assertive" (read right
// away). Same pattern as create-user-button.tsx. While saving it shows nothing,
// because the Save button already shows its own "Saving…" spinner.
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

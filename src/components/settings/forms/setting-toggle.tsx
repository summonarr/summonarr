"use client";

import { useId, useState, type ReactNode } from "react";
import { Loader2 } from "@/components/icons";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";
import { cn } from "@/lib/utils";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave, type SaveStatus } from "./shared";

// The settings switches that save themselves the moment they are flipped.
export type ToggleSettingKey =
  | "request4kAll"
  | "enableUserEmails"
  | "requireMfaForAdmins"
  | "disableLocalLogin"
  | "jellyfinRestrictSignIn"
  | "enableMachineSession"
  | "plexWatchlistServerSource"
  | "plexWatchlistServerAutoEnroll";

/**
 * One boolean setting, saved on flip. The switch moves at once and flips back
 * when the route refuses the write or never answers, so it never shows a value
 * the server doesn't hold.
 *
 * Only one save at a time: the row disables the switch while a save runs.
 * Several of these keys skip the settings route's per-key cooldown (so a quick
 * second click to undo isn't refused with a 429), which means nothing else
 * stops two saves overlapping, and two overlapping saves could finish in the
 * wrong order and leave the switch showing the opposite of what was stored.
 */
export function useSettingToggle(settingKey: ToggleSettingKey, initial: boolean) {
  const [value, setValue] = useState(initial);
  const { status, message, save } = useSettingsSave();
  async function set(next: boolean) {
    const prev = value;
    setValue(next);
    const result = await save({ [settingKey]: next ? "true" : "false" });
    if (!result.ok) setValue(prev);
  }
  return { value, status, message, set };
}

/**
 * The switch row. The parent card owns the dividers (divide-y) and each row
 * its vertical padding (`className`). The result is announced through the
 * shared live region (SaveStatusMessage), and an error wraps onto its own
 * full-width line instead of pushing the switch off-card at 375px.
 */
export function SettingToggleRow({
  title,
  help,
  note,
  checked,
  onCheckedChange,
  disabled,
  status,
  message,
  className,
  titleId: givenTitleId,
  children,
}: {
  title: ReactNode;
  help: ReactNode;
  /** A line under the help text, outside the switch's description. */
  note?: ReactNode;
  checked: boolean;
  onCheckedChange: () => void;
  /** Defaults to "while saving". */
  disabled?: boolean;
  status: SaveStatus;
  message: string;
  className?: string;
  /** For a caller whose own markup (`children`) names the row's title. */
  titleId?: string;
  /** Rendered under the row, above the error line. */
  children?: ReactNode;
}) {
  const t = useT();
  const ownTitleId = useId();
  const descId = useId();
  const titleId = givenTitleId ?? ownTitleId;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium text-zinc-200">{title}</p>
        <p id={descId} className="text-xs text-zinc-500 mt-0.5">{help}</p>
        {note}
      </div>
      <div className="flex items-center gap-2">
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
        {status === "ok" && <SaveStatusMessage status="ok" />}
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled ?? status === "saving"}
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="shrink-0"
        />
      </div>
      {children}
      {status === "error" && (
        <div className="basis-full">
          <SaveStatusMessage status="error" errorLabel={message || t("settings.form.common.saveFailed")} />
        </div>
      )}
    </div>
  );
}

/** A boolean setting's whole row: the hook and the row together. */
export function SettingToggle({
  settingKey,
  initialEnabled,
  title,
  help,
  className,
}: {
  settingKey: ToggleSettingKey;
  initialEnabled: boolean;
  title: ReactNode;
  help: ReactNode;
  className?: string;
}) {
  const toggle = useSettingToggle(settingKey, initialEnabled);
  return (
    <SettingToggleRow
      title={title}
      help={help}
      checked={toggle.value}
      onCheckedChange={() => void toggle.set(!toggle.value)}
      status={toggle.status}
      message={toggle.message}
      className={className}
    />
  );
}

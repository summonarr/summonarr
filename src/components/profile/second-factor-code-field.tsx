"use client";

import { Input } from "@/components/ui/input";
import { useT } from "@/components/i18n/i18n-provider";

// The verification-code field a change behind the second-factor step-up shows
// (use-second-factor-step-up.ts). Empty means "use a passkey" when one can be.
export function SecondFactorCodeField({
  id,
  value,
  onChange,
  passkeyPossible,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  passkeyPossible: boolean;
}) {
  const t = useT();
  return (
    <div>
      <label className="block text-sm text-zinc-400 mb-1" htmlFor={id}>
        {t("profile.mfa.stepUp.label")}{" "}
        <span className="text-zinc-500">
          {passkeyPossible ? t("profile.mfa.stepUp.hintWithPasskey") : t("profile.mfa.stepUp.hint")}
        </span>
      </label>
      <Input
        id={id}
        autoComplete="one-time-code"
        maxLength={24}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-56"
      />
    </div>
  );
}

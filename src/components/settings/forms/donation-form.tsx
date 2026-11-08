"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

interface DonationFormProps {
  initialPaypal: string;
  initialVenmo: string;
  initialZelle: string;
  initialAmazon: string;
  initialPatreon: string;
  initialBuyMeACoffee: string;
}

// One row per donation link: its Setting key, input id, label and placeholder
// (a catalog key, or a literal for the Amazon URL). Labels that are brand
// names stay as they are in every language.
const DONATION_FIELDS = [
  { key: "donationPaypal", id: "donation-paypal", prop: "initialPaypal", label: "PayPal", placeholderKey: "settings.form.donation.paypalPlaceholder" },
  { key: "donationVenmo", id: "donation-venmo", prop: "initialVenmo", label: "Venmo", placeholderKey: "settings.form.donation.venmoPlaceholder" },
  { key: "donationZelle", id: "donation-zelle", prop: "initialZelle", label: "Zelle", placeholderKey: "settings.form.donation.zellePlaceholder" },
  { key: "donationAmazon", id: "donation-amazon", prop: "initialAmazon", labelKey: "settings.form.donation.amazonLabel", placeholder: "https://www.amazon.com/hz/wishlist/ls/…" },
  { key: "donationPatreon", id: "donation-patreon", prop: "initialPatreon", label: "Patreon", placeholderKey: "settings.form.donation.patreonPlaceholder" },
  { key: "donationBuyMeACoffee", id: "donation-bmac", prop: "initialBuyMeACoffee", label: "Buy Me a Coffee", placeholderKey: "settings.form.donation.bmacPlaceholder" },
] as const satisfies readonly {
  key: string;
  id: string;
  prop: keyof DonationFormProps;
  label?: string;
  labelKey?: string;
  placeholder?: string;
  placeholderKey?: string;
}[];

type DonationKey = (typeof DONATION_FIELDS)[number]["key"];

export function DonationForm(props: DonationFormProps) {
  const t = useT();
  const [values, setValues] = useState<Record<DonationKey, string>>(
    () => Object.fromEntries(DONATION_FIELDS.map((f) => [f.key, props[f.prop]])) as Record<DonationKey, string>,
  );
  // The route says WHY a save failed (https-only link, cooldown, too long) —
  // `message` is shown instead of a bare "Failed to save". Only the success
  // state auto-dismisses; an error stays until the admin edits a field or
  // saves again.
  const { status, message, save, edited } = useSettingsSave();

  function setField(key: DonationKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save({ ...values });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {DONATION_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={f.id}>{"labelKey" in f ? t(f.labelKey) : f.label}</Label>
          <Input
            id={f.id}
            value={values[f.key]}
            onChange={(e) => { setField(f.key, e.target.value); edited(); }}
            placeholder={"placeholderKey" in f ? t(f.placeholderKey) : f.placeholder}
            className="bg-zinc-800 border-zinc-700 text-sm"
          />
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("settings.form.common.saving")}</> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={message || t("settings.form.common.saveFailed")} />
      </div>
    </form>
  );
}

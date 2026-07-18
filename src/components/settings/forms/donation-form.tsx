"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";

interface DonationFormProps {
  initialPaypal: string;
  initialVenmo: string;
  initialZelle: string;
  initialAmazon: string;
  initialPatreon: string;
  initialBuyMeACoffee: string;
}

export function DonationForm({ initialPaypal, initialVenmo, initialZelle, initialAmazon, initialPatreon, initialBuyMeACoffee }: DonationFormProps) {
  const [paypal,        setPaypal]        = useState(initialPaypal);
  const [venmo,         setVenmo]         = useState(initialVenmo);
  const [zelle,         setZelle]         = useState(initialZelle);
  const [amazon,        setAmazon]        = useState(initialAmazon);
  const [patreon,       setPatreon]       = useState(initialPatreon);
  const [buyMeACoffee,  setBuyMeACoffee]  = useState(initialBuyMeACoffee);
  const [status,        setStatus]        = useState<SaveStatus>("idle");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          donationPaypal:       paypal,
          donationVenmo:        venmo,
          donationZelle:        zelle,
          donationAmazon:       amazon,
          donationPatreon:      patreon,
          donationBuyMeACoffee: buyMeACoffee,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setStatus(res.ok && data.ok !== false ? "ok" : "error");
    } catch {
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="donation-paypal">PayPal</Label>
        <Input
          id="donation-paypal"
          value={paypal}
          onChange={(e) => { setPaypal(e.target.value); setStatus("idle"); }}
          placeholder="paypal.me/yourname or email address"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-venmo">Venmo</Label>
        <Input
          id="donation-venmo"
          value={venmo}
          onChange={(e) => { setVenmo(e.target.value); setStatus("idle"); }}
          placeholder="@your-venmo-handle"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-zelle">Zelle</Label>
        <Input
          id="donation-zelle"
          value={zelle}
          onChange={(e) => { setZelle(e.target.value); setStatus("idle"); }}
          placeholder="Email or phone number registered with Zelle"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-amazon">Amazon Wishlist</Label>
        <Input
          id="donation-amazon"
          value={amazon}
          onChange={(e) => { setAmazon(e.target.value); setStatus("idle"); }}
          placeholder="https://www.amazon.com/hz/wishlist/ls/…"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-patreon">Patreon</Label>
        <Input
          id="donation-patreon"
          value={patreon}
          onChange={(e) => { setPatreon(e.target.value); setStatus("idle"); }}
          placeholder="your-patreon-handle or full Patreon URL"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="donation-bmac">Buy Me a Coffee</Label>
        <Input
          id="donation-bmac"
          value={buyMeACoffee}
          onChange={(e) => { setBuyMeACoffee(e.target.value); setStatus("idle"); }}
          placeholder="your-bmac-handle or full Buy Me a Coffee URL"
          className="bg-zinc-800 border-zinc-700 text-sm"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save"}
        </Button>
        <SaveStatusMessage status={status} />
      </div>
    </form>
  );
}

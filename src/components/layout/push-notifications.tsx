"use client";

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from "react";
import { Bell, BellOff, Send } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useT } from "@/components/i18n/i18n-provider";
import { cn } from "@/lib/utils";
import { usePushNotifications, type PushTestState } from "@/components/layout/use-push-notifications";

// The header's web-push control: a 32px bell that enables, disables and tests
// this browser's notifications. The flows live in usePushNotifications; the
// requests in src/lib/client/push-subscription.ts.
export function PushNotifications() {
  // Gate first render on `useHasMounted` so SSR and the first client render
  // both emit nothing — otherwise the parent's child count disagrees with the
  // SSR DOM (React #418 on /, /movies, /admin/library etc.).
  const mounted = useHasMounted();
  const t = useT();
  const push = usePushNotifications();
  // Kept across a failed enable, so a retry doesn't retype it.
  const [deviceName, setDeviceName] = useState("");
  const errorId = useId();

  if (!mounted || push.state === "loading") return null;

  if (push.state === "unsupported") {
    return (
      <PushIconButton
        disabled
        label={t("shared.push.unsupportedAria")}
        title={t("shared.push.unsupportedTitle")}
        className="cursor-not-allowed"
        // fg-disabled, not zinc-700: zinc-700 is a background colour in this
        // theme, so the icon would vanish into the header.
        style={{ color: "var(--ds-fg-disabled)" }}
      >
        <BellOff className="w-4 h-4" />
      </PushIconButton>
    );
  }

  if (push.state === "denied") {
    return (
      <PushIconButton
        disabled
        label={t("shared.push.blockedAria")}
        title={t("shared.push.blockedTitle")}
        className="text-zinc-500 cursor-not-allowed"
      >
        <BellOff className="w-4 h-4" />
      </PushIconButton>
    );
  }

  if (push.state === "naming") {
    return (
      <DeviceNameForm
        value={deviceName}
        onChange={setDeviceName}
        busy={push.busy}
        onSubmit={() => void push.subscribe(deviceName)}
        onCancel={() => { push.cancelNaming(); setDeviceName(""); }}
      />
    );
  }

  // This control is a 32px icon with no room for error text, so a failure
  // turns the bell red, puts the reason in its tooltip and its accessible
  // description (the name stays the action), and fail() also shows it as a
  // toast. The Send-test button signals its failures the same way, by colour.
  const errorNote = push.error ? <span id={errorId} hidden>{push.error}</span> : null;

  if (push.state === "subscribed") {
    return (
      <div className="flex items-center gap-1">
        <PushIconButton
          onClick={() => void push.unsubscribe()}
          disabled={push.busy}
          // A failed unsubscribe keeps this state, so show its error here.
          label={t("shared.push.disable")}
          title={push.error ?? t("shared.push.disable")}
          aria-describedby={push.error ? errorId : undefined}
          className={cn("transition-colors disabled:opacity-50", push.error ? "text-red-400" : "text-indigo-400 hover:text-indigo-300")}
        >
          <Bell className="w-4 h-4" />
        </PushIconButton>
        {errorNote}
        <PushIconButton
          onClick={() => void push.sendTest()}
          disabled={push.testState === "sending"}
          label={t("shared.push.sendTest")}
          className={cn("transition-colors disabled:opacity-50", TEST_STATE_CLASS[push.testState])}
        >
          <Send className="w-4 h-4" />
        </PushIconButton>
      </div>
    );
  }

  return (
    <>
      <PushIconButton
        onClick={push.startNaming}
        disabled={push.busy}
        label={t("shared.push.enableDesktop")}
        title={push.error ?? t("shared.push.enableDesktop")}
        aria-describedby={push.error ? errorId : undefined}
        className={cn(
          "transition-colors disabled:opacity-50",
          push.error ? "text-red-400 hover:text-[var(--ds-danger-hover)]" : "text-zinc-500 hover:text-zinc-300",
        )}
      >
        <BellOff className="w-4 h-4" />
      </PushIconButton>
      {errorNote}
    </>
  );
}

const TEST_STATE_CLASS: Record<PushTestState, string> = {
  idle: "text-zinc-500 hover:text-zinc-300",
  sending: "text-zinc-500 hover:text-zinc-300",
  ok: "text-green-400",
  error: "text-red-400",
};

const ICON_BUTTON_STYLE: CSSProperties = { width: 32, height: 32, borderRadius: 6 };

// The 32x32 icon button every state draws. The aria-label lets screen readers
// (VoiceOver, TalkBack) announce it; a `title` alone is unreliable on mobile.
function PushIconButton({
  label,
  title,
  className,
  style,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "type"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      className={cn("ds-tap inline-flex items-center justify-center shrink-0", className)}
      style={{ ...ICON_BUTTON_STYLE, ...style }}
      {...rest}
    />
  );
}

function DeviceNameForm({
  value,
  onChange,
  busy,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Wait one tick so the input exists before we focus it.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    // min-w-0 + a shrinkable input: in the 375px mobile top bar this form
    // sits beside the menu/search/notification controls, and a fixed-width
    // row ran past the right edge. Controls stay h-8 (tap-target floor).
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("shared.push.devicePlaceholder")}
        maxLength={100}
        aria-label={t("shared.push.deviceName")}
        className="w-40 shrink md:text-xs"
      />
      <Button
        type="submit"
        size="sm"
        className="h-8 shrink-0"
        disabled={busy}
        aria-label={t("shared.push.enableAria")}
      >
        {t("shared.push.enable")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 shrink-0"
        // An enable in flight would finish after a Cancel and subscribe anyway.
        disabled={busy}
        onClick={onCancel}
      >
        {t("shared.common.cancel")}
      </Button>
    </form>
  );
}

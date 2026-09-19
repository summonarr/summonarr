import Link from "next/link";
import { isValidElement, type CSSProperties, type ReactNode } from "react";
import { withBasePath } from "@/lib/base-path";

// One shell for every "you are not looking at content" page: the two
// not-found boundaries, the (app) and admin error boundaries, and the
// maintenance gate. Server-safe on purpose — no hooks, no "use client" — so
// the server-rendered not-found/maintenance pages ship no client JS for it,
// while a "use client" error boundary can still render it and drop its own
// client <button> into the `primary` slot (retry() is a client callback).
//
// global-error.tsx deliberately does NOT import this: it replaces the whole
// document and cannot rely on the app's fonts or the router; it mirrors these
// styles inline instead. Keep the two in step.

export interface StatePageAction {
  label: string;
  href: string;
  icon?: ReactNode;
  /**
   * Render a plain <a> (full document load) instead of a client-side <Link>.
   * For a "reload" action: an empty href resolves to the document's own URL.
   */
  hard?: boolean;
}

// Exported so a client error boundary can style its own <button> identically.
export const STATE_PAGE_CTA_CLASS =
  "ds-tap ds-hover-tint inline-flex items-center justify-center gap-2 font-medium";

export function statePageCtaStyle(kind: "primary" | "secondary"): CSSProperties {
  return kind === "primary"
    ? {
        background: "var(--ds-accent)",
        color: "var(--ds-accent-fg)",
        borderRadius: 10,
        minHeight: 44,
        fontSize: 14,
      }
    : {
        background: "var(--ds-bg-2)",
        color: "var(--ds-fg)",
        border: "1px solid var(--ds-border)",
        borderRadius: 10,
        minHeight: 44,
        fontSize: 14,
      };
}

// Shared copy for the two not-found boundaries (root + (app)); they catch
// different cases but must read identically.
export const NOT_FOUND_COPY = {
  title: "Couldn't find that page",
  description:
    "That page doesn't exist. It may have been removed, or the link may be wrong.",
} as const;

function isAction(value: unknown): value is StatePageAction {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isValidElement(value) &&
    typeof (value as StatePageAction).label === "string" &&
    typeof (value as StatePageAction).href === "string"
  );
}

function ActionLink({
  action,
  kind,
}: {
  action: StatePageAction;
  kind: "primary" | "secondary";
}) {
  const style = statePageCtaStyle(kind);
  const body = (
    <>
      {action.icon}
      {action.label}
    </>
  );
  if (action.hard) {
    return (
      <a href={withBasePath(action.href)} className={STATE_PAGE_CTA_CLASS} style={style}>
        {body}
      </a>
    );
  }
  return (
    <Link href={action.href} className={STATE_PAGE_CTA_CLASS} style={style}>
      {body}
    </Link>
  );
}

export function StatePage({
  glyph,
  title,
  description,
  primary,
  secondary,
  children,
  frame = "app",
}: {
  /** The big mono "404"/"500"-style label, or any node (an icon). */
  glyph?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Either a link config (rendered as the accent CTA) or a ready-made node. */
  primary?: StatePageAction | ReactNode;
  secondary?: StatePageAction[];
  children?: ReactNode;
  /**
   * "app": sits inside the (app) <main> under the header — top-aligned so the
   * glyph doesn't drift to the middle of a tall scroll area.
   * "document": there is no chrome around it (root not-found, maintenance) —
   * fills the viewport and centres.
   */
  frame?: "app" | "document";
}) {
  const hasActions = Boolean(primary) || (secondary?.length ?? 0) > 0;
  return (
    <div
      className={
        frame === "document"
          ? "ds-page-enter flex flex-col items-center justify-center px-6"
          : "ds-page-enter flex flex-col items-center justify-start px-6"
      }
      style={
        frame === "document"
          ? { minHeight: "100dvh", paddingTop: 48, paddingBottom: 48 }
          : { paddingTop: 64, paddingBottom: 64, minHeight: "60vh" }
      }
    >
      {glyph != null && (
        <div
          className="ds-mono flex items-center justify-center"
          aria-hidden
          style={{
            fontSize: 64,
            fontWeight: 700,
            color: "var(--ds-fg-muted)",
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          {glyph}
        </div>
      )}
      <h1
        className="m-0 text-center"
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--ds-fg)",
          marginTop: glyph != null ? 12 : 0,
        }}
      >
        {title}
      </h1>
      {description != null && (
        <p
          className="text-center"
          style={{
            fontSize: 14,
            color: "var(--ds-fg-muted)",
            marginTop: 8,
            maxWidth: 320,
            lineHeight: 1.5,
          }}
        >
          {description}
        </p>
      )}
      {children}
      {hasActions && (
        <div
          className="flex flex-col items-stretch gap-2"
          style={{ marginTop: 28, width: "100%", maxWidth: 280 }}
        >
          {isAction(primary) ? <ActionLink action={primary} kind="primary" /> : primary}
          {secondary?.map((action) => (
            <ActionLink key={action.href || action.label} action={action} kind="secondary" />
          ))}
        </div>
      )}
    </div>
  );
}

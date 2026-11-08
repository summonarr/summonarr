import type { ReactNode } from "react";
import { iconA11y } from "./icon-a11y";
import type { IconProps } from "./types";

// The <svg> every icon in this folder renders — one copy of the attributes and
// the accessibility rule, so a change lands in every icon at once (it used to
// be pasted into each file by hand). Each icon passes only its shapes.
//
// Decorative by default; only a label exposes an icon (the rule is iconA11y).
// role and aria-hidden are taken out of the spread so the rule decides them.
export function IconBase({ size, children, role, "aria-hidden": ariaHidden, ...props }: IconProps & { children: ReactNode }) {
  const a11y = iconA11y({ ...props, role, "aria-hidden": ariaHidden });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 24}
      height={size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={a11y.role}
      aria-hidden={a11y["aria-hidden"]}
      {...props}
    >
      {children}
    </svg>
  );
}

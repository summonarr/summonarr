import type { ReactNode } from "react";
import type { IconProps } from "./index";

// The <svg> every icon in this folder renders — one copy of the attributes and
// the accessibility rule, so a change lands in every icon at once (it used to
// be pasted into each file by hand). Each icon passes only its shapes.
//
// Decorative by default: an icon with no label is aria-hidden. A labelled icon
// (aria-label / aria-labelledby) is exposed as role="img", because assistive
// tech announces an un-roled labelled <svg> inconsistently. A caller's own
// `role` / `aria-hidden` still wins: the spread comes last.
export function IconBase({ size, children, ...props }: IconProps & { children: ReactNode }) {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
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
      role={labelled ? "img" : undefined}
      aria-hidden={labelled || props.role === "img" ? undefined : true}
      {...props}
    >
      {children}
    </svg>
  );
}

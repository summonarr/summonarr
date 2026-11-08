import type { IconProps } from "./types";

// The accessibility attributes an icon's <svg> gets. Only a NAME exposes an
// icon: a labelled one (aria-label / aria-labelledby) is role="img" unless the
// caller chose another role; an unlabelled one is aria-hidden and never claims
// role="img", which would be announced as a bare, unnamed "image". A caller's
// explicit aria-hidden and any other role are kept.
export function iconA11y(props: Pick<IconProps, "role" | "aria-hidden" | "aria-label" | "aria-labelledby">): {
  role: IconProps["role"];
  "aria-hidden": IconProps["aria-hidden"];
} {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
  const role = labelled ? (props.role ?? "img") : props.role === "img" ? undefined : props.role;
  return { role, "aria-hidden": props["aria-hidden"] ?? (labelled ? undefined : true) };
}

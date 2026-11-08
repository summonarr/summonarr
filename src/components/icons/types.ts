import type { JSX, SVGProps } from "react";

// The icon types live here, not in the barrel: every icon imports them, and the
// barrel re-exports every icon, so declaring them there tied each leaf back to it.
export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};
export type IconComponent = (props: IconProps) => JSX.Element;

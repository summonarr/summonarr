import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function Smartphone(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </IconBase>
  );
}

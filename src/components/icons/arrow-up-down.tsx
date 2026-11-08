import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function ArrowUpDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m21 16-4 4-4-4" />
      <path d="M17 20V4" />
      <path d="m3 8 4-4 4 4" />
      <path d="M7 4v16" />
    </IconBase>
  );
}

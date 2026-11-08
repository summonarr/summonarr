import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function MoreHorizontal(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </IconBase>
  );
}

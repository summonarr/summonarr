import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function ArrowUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </IconBase>
  );
}

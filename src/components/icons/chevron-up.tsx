import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function ChevronUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m18 15-6-6-6 6" />
    </IconBase>
  );
}

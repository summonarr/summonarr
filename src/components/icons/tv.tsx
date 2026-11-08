import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function Tv(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m17 2-5 5-5-5" />
      <rect width="20" height="15" x="2" y="7" rx="2" />
    </IconBase>
  );
}

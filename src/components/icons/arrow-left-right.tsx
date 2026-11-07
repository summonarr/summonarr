import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function ArrowLeftRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m8 3-4 4 4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </IconBase>
  );
}

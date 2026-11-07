import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function UserCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m16 11 2 2 4-4" />
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </IconBase>
  );
}

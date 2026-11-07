import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function Ban(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M4.929 4.929 19.07 19.071" />
    </IconBase>
  );
}

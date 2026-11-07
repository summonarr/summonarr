import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function Circle(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
    </IconBase>
  );
}

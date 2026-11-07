import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function Plus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </IconBase>
  );
}

import { IconBase } from "./icon-base";
import type { IconProps } from "./index";

export function Menu(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 5h16" />
      <path d="M4 12h16" />
      <path d="M4 19h16" />
    </IconBase>
  );
}

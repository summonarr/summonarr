import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function Library(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </IconBase>
  );
}

import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function ArrowLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </IconBase>
  );
}

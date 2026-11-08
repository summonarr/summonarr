import { IconBase } from "./icon-base";
import type { IconProps } from "./types";

export function BookmarkCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      <path d="m9 10 2 2 4-4" />
    </IconBase>
  );
}

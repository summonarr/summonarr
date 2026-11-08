"use client";

// A segmented control's visible label tied to its buttons for assistive tech:
// the buttons sit in a role="group" named by the label (aria-labelledby), so a
// screen reader announces "Source, group: Plex, pressed" instead of a bare
// "Plex, pressed". Styling stays with each caller (the Activity filter bar and
// the History filter bar draw theirs differently); `after` renders inside the
// same wrapper, behind the group (the Period filter's custom-days field).

import { useId, type CSSProperties, type ReactNode } from "react";

export function LabelledSegGroup({
  label,
  className,
  style,
  labelClassName,
  labelStyle,
  groupClassName,
  groupStyle,
  after,
  children,
}: {
  label: ReactNode;
  className?: string;
  style?: CSSProperties;
  labelClassName?: string;
  labelStyle?: CSSProperties;
  groupClassName?: string;
  groupStyle?: CSSProperties;
  after?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className={className} style={style}>
      <span id={labelId} className={labelClassName} style={labelStyle}>
        {label}
      </span>
      <div role="group" aria-labelledby={labelId} className={groupClassName} style={groupStyle}>
        {children}
      </div>
      {after}
    </div>
  );
}

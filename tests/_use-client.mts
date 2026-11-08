// Whether a source file opens with a "use client" directive: only whitespace
// and comments may precede it. A linear scan, not a regex, so a file with an
// unterminated or very long comment cannot make the check backtrack.
export function hasUseClientDirective(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "﻿") {
      i++;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      if (end === -1) return false;
      i = end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      break;
    }
  }
  return text.startsWith('"use client"', i) || text.startsWith("'use client'", i);
}

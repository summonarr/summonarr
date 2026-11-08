// The ARIA radio group pattern's keyboard rule, for the appearance picker's
// standalone form. Pure, so the unit suite loads it.

/** Which option an arrow/Home/End key moves to, or null for any other key.
 *  Wraps at both ends, as the ARIA radio group pattern does. */
export function radioKeyTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

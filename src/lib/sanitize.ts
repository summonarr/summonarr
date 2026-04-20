
export function parsePositiveInt(value: string | null | undefined, fallback: number | null = null): number | null {
  if (value == null) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function sanitizeText(input: string): string {
  return input
    .replace(/[<>]/g, "")
    .replace(/\0/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, "")
    // Unicode bidi-override characters can reverse displayed text in logs/UI — strip them
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
}

export function sanitizeOptional(input: string | undefined | null): string | null {
  if (input == null) return null;
  const cleaned = sanitizeText(input);
  return cleaned || null;
}

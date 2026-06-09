
export function sanitizeText(input: string): string {
  return input
    .replace(/[<>]/g, "")
    .replace(/\0/g, "")
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

export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\r\n]/g, " ");
}

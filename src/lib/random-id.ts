// A random v4 UUID that works in every browser context.
//
// crypto.randomUUID only exists in SECURE contexts (HTTPS or localhost), so on a
// plain-HTTP LAN or local-only deployment it is undefined and calling it throws.
// crypto.getRandomValues is available everywhere; build the same v4 shape from
// it when randomUUID is missing. Zero imports, so client code may use it.
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

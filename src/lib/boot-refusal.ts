// How a failed boot check ends (src/instrumentation.ts). Every check runs and
// logs first, so the operator sees every problem in one boot; then the server
// exits once if any of them refuses to start here. Pure and zero-import.

/** "always": refuse in every environment. "production": refuse only in production. */
export type BootRefusal = "always" | "production";

export function bootRefused(refusals: readonly BootRefusal[], nodeEnv: string | undefined): boolean {
  return refusals.includes("always") || (refusals.length > 0 && nodeEnv === "production");
}

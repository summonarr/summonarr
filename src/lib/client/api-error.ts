// The reason an API route gave for a failed request, read the same way on every
// admin page.
//
// `message` first: a conflict answers { error: "<slug>", message: "<sentence>" }
// (an issue's status or claim moved on since the page loaded), and the slug
// alone is noise. Then `error`. Anything else gives the caller's fallback: a
// body that isn't JSON (a reverse proxy's HTML error page), an empty field, or
// a field that isn't a string.
//
// Zero imports, so the unit suite loads it directly (tests/api-error.test.mts).

/** The route's own reason in an already-parsed body, else `fallback`. */
export function apiErrorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

/** The route's own reason for a failed response, else `fallback`. Reads the body. */
export async function readApiError(res: Response, fallback: string): Promise<string> {
  return apiErrorText(await res.json().catch(() => null), fallback);
}

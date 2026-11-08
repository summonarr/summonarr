// The email settings form's request body and answer (email-form.tsx). Pure so
// the unit suite runs it directly (tests/settings-forms-save-state.test.mts).

/** The keys the route left unchanged (a blank value it can't clear). */
export function ignoredKeys(data: Record<string, unknown>): string[] {
  return Array.isArray(data.ignored) ? data.ignored.filter((k): k is string => typeof k === "string") : [];
}

/**
 * The PATCH body. A secret field is EMPTY when one is saved (the mask is only
 * its placeholder), and an empty secret is not sent: the route can't clear it,
 * so the saved one is kept. `emailBackend` is always sent: it is what asks the
 * route to test the settings (a test email).
 */
export function emailSaveBody(f: {
  backend: "smtp" | "resend";
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
  resendApiKey: string;
  resendFrom: string;
}): Record<string, string> {
  const body: Record<string, string> = { emailBackend: f.backend };
  if (f.backend === "smtp") {
    body.smtpHost = f.host;
    body.smtpPort = f.port;
    body.smtpUser = f.user;
    if (f.password) body.smtpPassword = f.password;
    body.smtpFrom = f.from;
  } else {
    if (f.resendApiKey) body.resendApiKey = f.resendApiKey;
    body.resendFrom = f.resendFrom;
  }
  return body;
}

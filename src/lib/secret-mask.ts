// The placeholder a settings form sends back for a secret it never showed:
// /api/settings and the admin instance routes (arr-instances, media-instances)
// read it as "keep the saved value" and skip the write, and GET /api/settings
// returns it in place of a stored secret. The forms, the settings page and the
// routes import this one constant, so the two sides can't drift — a client
// sending a value the server doesn't recognize would store the bullets as the
// real API key or token.
//
// PURE, zero imports: imported by "use client" components and server routes.
export const SECRET_MASK_SENTINEL = "••••••••";

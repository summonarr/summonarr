// What the detail page's main Request button shows, decided in one place.
// Pure and zero-import, so the unit suite loads it directly
// (tests/request-button-rules.test.mts).
//
//   - `cta`: the viewer's own request controls (Request, Add note, and
//     "Request for user…" for an on-behalf holder).
//   - `blocked`: the muted "not available to request" status — the title is
//     blacklisted, or the viewer's own request was permanently declined (the
//     request route refuses both on every attempt).
//   - `onBehalfOnly`: "Request for user…" on its own. The viewer's state (they
//     already requested it, they can see a copy, their request was permanently
//     declined, they can't request this media type) says nothing about the
//     user they are filing for: the bulk route judges the TARGET's requests,
//     visibility and permissions. Only a blacklist, which blocks everyone,
//     removes it.
export function mainRequestView(input: {
  isAvailable: boolean;
  showViewRequest: boolean;
  blacklisted: boolean;
  permanentlyDeclined: boolean;
  canRequest: boolean;
  canRequestOnBehalf: boolean;
}): { cta: boolean; blocked: boolean; onBehalfOnly: boolean } {
  const open = !input.isAvailable && !input.showViewRequest;
  const refused = input.blacklisted || input.permanentlyDeclined;
  const cta = open && !refused && input.canRequest;
  return {
    cta,
    blocked: open && refused,
    onBehalfOnly: input.canRequestOnBehalf && !input.blacklisted && !cta,
  };
}

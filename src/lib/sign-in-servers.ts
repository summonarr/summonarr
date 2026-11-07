// The Jellyfin sign-in server picker's entries, for the two pre-sign-in
// surfaces that show it: the web login page (a server component handing props
// to a client component) and GET /api/auth/jellyfin/servers (native clients).
// Both are unauthenticated, so an entry carries only what the picker needs to
// label an option and echo the choice back at sign-in: never a server URL or
// key, and not the registry's `restricted` flag (a per-user library-visibility
// concern that says nothing about sign-in). One projection, so the page and
// the route can't drift.
export interface SignInServerOption {
  slug: string;
  name: string;
}

export function signInServerOptions(
  instances: readonly { slug: string; name: string }[],
): SignInServerOption[] {
  return instances.map(({ slug, name }) => ({ slug, name }));
}

# Privacy Policy

**Effective date:** June 15, 2026

This policy covers **Summonarr** — the self-hosted server software and the official
**Summonarr for iOS** client app.

---

## The short version

Summonarr is free, open-source, **self-hosted** software. There is no Summonarr
company, cloud, or central server. The developer **operates no servers, runs no
analytics, and never receives any of your data.**

The iOS app is a client for a server that **you** (or whoever administers your
instance) run yourself. Your account, requests, watch history, and everything
else live on that server, under your control — not ours.

---

## Who is responsible for your data

Because Summonarr is self-hosted, the **operator of the server you connect to**
is the data controller for everything stored in it. If you run your own
instance, that's you. If you connect to someone else's instance, it's whoever
runs it — direct any data questions to that administrator.

The developer of Summonarr is **not** a party to that data. We publish open-source
software; we do not host it for you and cannot see your instance.

## What the iOS app stores on your device

The app keeps only what it needs to talk to your server. Nothing here leaves your
device except requests you make to your own server:

- **Server address** — the URL you enter, saved in the app's local settings
  (`UserDefaults`) so you don't have to retype it.
- **Session token** — after you sign in, an authentication token is stored in the
  iOS **Keychain** (encrypted by the system). It is sent only to your server, only
  to prove you're signed in.
- **Display preferences** — e.g. light/dark appearance, stored locally.

Signing out removes the session token from the Keychain.

## What your server processes (not the developer)

When you use Summonarr, your **self-hosted server** may store, depending on how its
administrator configured it: your account details (username, email, and — for local
accounts — a hashed password), your media requests, votes, and issue reports, your
playback/watch history and active-session details (which can include device name,
IP address, and stream technical data), per-device login sessions, and encrypted
credentials for connected services (Plex, Jellyfin, Radarr, Sonarr, OIDC).

All of this is held **on your server**, controlled by its administrator, and
encrypted at rest where it is sensitive. **None of it is transmitted to the
developer of Summonarr.**

## Network connections the app makes

The app makes only two kinds of outbound connection:

1. **Your server.** All sign-in, browsing, requests, and account actions go to the
   server address you entered — and nowhere else.
2. **Movie/TV artwork from TMDB.** Poster, backdrop, and cast images are loaded
   directly from The Movie Database's image CDN (`image.tmdb.org`). Like any web
   request, this exposes your device's IP address to TMDB and tells their CDN which
   image you're viewing. **No account information, credentials, or identifiers are
   sent.** TMDB's handling of such requests is governed by their own privacy policy:
   <https://www.themoviedb.org/privacy-policy>.

The app contacts no other services.

## No tracking, analytics, or ads

- **No tracking.** The app does not track you across apps or websites, and contains
  no advertising or attribution SDKs. (`NSPrivacyTracking` is `false`.)
- **No analytics.** There is no crash reporting, telemetry, or usage analytics of
  any kind.
- **No third-party SDKs** that collect data, and **no data brokers**.
- **No data is collected by the developer** — the app's privacy manifest declares
  **no collected data types**.

## Security

- The session token is stored in the iOS Keychain; display/server settings in
  local app storage.
- We recommend running your server over **HTTPS**. The app permits plain-HTTP and
  self-signed connections only because self-hosted servers are commonly reached over
  a LAN or a reverse proxy with a self-signed certificate — the target is always an
  address you chose.
- On the server side, sensitive credentials and tokens are encrypted at rest
  (AES-256-GCM). Server security ultimately depends on how the administrator deploys
  it.

## Your choices and rights

- **See or delete your data:** ask the administrator of your instance, or — if you
  run it — use the admin tools and database directly. Account deletion and session
  revocation are available in the app/server.
- **Disconnect:** sign out to clear the local session token, or remove the app to
  clear all locally stored data.
- Any statutory rights you have (e.g. under GDPR or CCPA) are exercised against the
  operator of the server you use, since they hold the data.

## Children's privacy

Summonarr is general-purpose software for managing a personal media library and is
not directed at children under 13. The developer knowingly collects no data from
anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be published here with a new
effective date. Material changes will be noted in the project's release notes.

## Contact

Summonarr is an open-source project. Questions about this policy or the app can be
raised at:

- **GitHub:** <https://github.com/summonarr/summonarr/issues>

For data held by a specific Summonarr instance you don't operate, contact that
instance's administrator.

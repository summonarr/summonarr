// The iOS app's App Store listing. Hardcoded on purpose, never a Setting: an
// App Store link is something a client opens, and guardrail 25 keeps those out
// of anything a server operator (or a compromised server) can rewrite.
export const IOS_APP_STORE_ID = "6780986774";
export const IOS_APP_STORE_URL = `https://apps.apple.com/us/app/summonarr/id${IOS_APP_STORE_ID}`;

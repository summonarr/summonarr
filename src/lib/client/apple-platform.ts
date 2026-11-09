// Whether the browser runs on an Apple platform (the ⌘ key is the shortcut
// modifier). Browser-only: call it after mount, never in a render path.
// userAgentData is preferred; navigator.platform is the fallback where it is
// missing, and the user agent the last resort.
export function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

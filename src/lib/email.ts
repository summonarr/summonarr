import { promises as dns } from "dns";
import { isIP } from "net";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { resolveUserNotificationEmail } from "@/lib/notification-email";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { isSafeAddrForAdmin } from "@/lib/ssrf";
import { sendMail, type SmtpConfig } from "@/lib/smtp";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";
import { settleLimit } from "@/lib/concurrency";
import { localeForUser, translatorFor } from "@/lib/i18n/server-locale";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/translate";
import { issueTypeLabelT, mediaLabelT } from "@/lib/notify-i18n";

// Every email is written in its RECIPIENT's language: the user-facing notifiers
// take the recipient's stored `locale` (null → the instance default), and the
// admin fan-outs group recipients by their own locale and render once per group.
interface Lang {
  t: Translator;
  locale: Locale;
}

function langFor(locale: string | null | undefined): Lang {
  const resolved = localeForUser({ locale });
  return { t: translatorFor(resolved), locale: resolved };
}

interface Recipient {
  to: string;
  locale: string | null;
}

// Keys read from the Setting table. `emailBackend` picks the transport:
//   - "resend" → Resend HTTP API (direct POST to api.resend.com via safeFetchTrusted)
//   - "smtp"   → SMTP via our own small client in smtp.ts (the default when unset)
// Resend sender falls back to smtpFrom so users sharing one from-address
// don't have to enter it twice. siteUrl is read so CTAs can link to the app.
// `enableUserEmails` is the "Send notification emails" master switch: while it is
// off, getEmailConfig() returns null so EVERY notifier (user- and admin-facing
// alike) is muted — only the explicit admin test email bypasses it.
const EMAIL_KEYS = [
  "emailBackend",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPassword",
  "smtpFrom",
  "resendApiKey",
  "resendFrom",
  "siteUrl",
  "enableUserEmails",
] as const;

type EmailBackend = "smtp" | "resend";

interface EmailConfig {
  backend: EmailBackend;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  resendApiKey?: string;
  resendFrom?: string;
  siteUrl?: string;
}

async function getEmailConfig(opts: { ignoreSendToggle?: boolean } = {}): Promise<EmailConfig | null> {
  if (!(await isFeatureEnabled("feature.integration.email"))) return null;
  const rows = await prisma.setting.findMany({ where: { key: { in: [...EMAIL_KEYS] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, string | undefined>;
  if (!opts.ignoreSendToggle && map.enableUserEmails !== "true") return null;
  const backend: EmailBackend = map.emailBackend === "resend" ? "resend" : "smtp";
  return {
    backend,
    smtpHost: map.smtpHost,
    smtpPort: map.smtpPort,
    smtpUser: map.smtpUser,
    smtpPassword: map.smtpPassword,
    smtpFrom: map.smtpFrom,
    resendApiKey: map.resendApiKey,
    resendFrom: map.resendFrom,
    siteUrl: map.siteUrl,
  };
}

// Returns true when the selected backend has the minimum config required to send.
function isBackendConfigured(cfg: EmailConfig): boolean {
  if (cfg.backend === "resend") return Boolean(cfg.resendApiKey);
  return Boolean(cfg.smtpHost);
}

// Whether notification emails can currently go out: feature flag on, the
// "Send notification emails" master switch on, and a transport configured.
// Mirrors the exact gate every notifier runs, so UI that keys off this
// (the profile email-preference section) can't drift from send behavior.
export async function isNotificationEmailEnabled(): Promise<boolean> {
  const cfg = await getEmailConfig();
  return cfg !== null && isBackendConfigured(cfg);
}

function resolveFromAddress(cfg: EmailConfig): string {
  if (cfg.backend === "resend") {
    return safeHeader(cfg.resendFrom || cfg.smtpFrom || "summonarr@localhost");
  }
  return safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
}

// Resolves `host`, validates every address, and returns one to use as the connect target.
// We hand the validated IP literal to our SMTP client (instead of the hostname) so a malicious
// DNS can't swap the answer between our pre-flight check and the connect-time lookup.
async function resolveSafeSmtpHost(host: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(host)) {
    if (!isSafeAddrForAdmin(host)) {
      throw new Error(`Refusing SMTP host ${host} — address is not allowed`);
    }
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) {
    throw new Error(`Refusing SMTP host ${host} — DNS returned no addresses`);
  }
  for (const a of addrs) {
    if (!isSafeAddrForAdmin(a.address)) {
      throw new Error(`Refusing SMTP host ${host} — resolves to ${a.address} which is not allowed`);
    }
  }
  const first = addrs[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

async function buildSmtpConfig(cfg: EmailConfig): Promise<SmtpConfig> {
  if (!cfg.smtpHost) throw new Error("SMTP host not configured");
  const resolved = await resolveSafeSmtpHost(cfg.smtpHost);
  const port = parseInt(cfg.smtpPort ?? "587", 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    // A non-numeric/out-of-range Setting value would otherwise make `secure` and
    // `requireTLS` both false and then crash net.connect with an opaque
    // "Port should be >= 0 and < 65536" deep in a fire-and-forget notifier.
    throw new Error(`Invalid SMTP port: ${cfg.smtpPort}`);
  }
  // Key the plaintext carve-out off the address we actually CONNECT to, never the
  // name the admin typed. `isSafeAddrForAdmin` deliberately permits RFC1918/ULA, so
  // an /etc/hosts entry or a resolver search domain can make "localhost" resolve
  // off-box; a name-based check would then hand `AUTH PLAIN <base64>` to a remote
  // relay over an unencrypted socket. Anything we can't prove is loopback keeps TLS.
  const connectAddr = resolved.address.replace(/^::ffff:/i, "");
  const isLoopback = connectAddr === "::1" || /^127\./.test(connectAddr);
  return {
    // Hand TLS the original hostname for SNI + certificate-name validation, while the TCP layer
    // connects to the validated IP. This closes the DNS-rebind window between resolveSafeSmtpHost
    // and the connect-time DNS lookup.
    host: cfg.smtpHost,
    resolvedAddress: resolved.address,
    port,
    secure: port === 465,
    // requireTLS enforces STARTTLS on port 587 but must be skipped for a loopback relay (plaintext dev/test)
    requireTLS: !isLoopback && port === 587,
    // The loopback carve-out is the ONLY place plaintext AUTH is permitted.
    // On any other host, sendMail refuses to transmit credentials unless the
    // channel is TLS (implicit 465 or a successful STARTTLS) — covers custom
    // ports (25/2525) where requireTLS above doesn't apply.
    allowPlaintextAuth: isLoopback,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword ?? "" } : undefined,
  };
}

// Central send dispatcher — every notifier in this file funnels through it.
// Throws on failure so callers that want loud errors (sendTestEmail) can catch;
// notifier functions wrap their own try/catch to stay silent on the happy path.
async function sendOne(cfg: EmailConfig, to: string, subject: string, html: string): Promise<void> {
  const from = resolveFromAddress(cfg);
  const safeSubjectText = safeSubject(subject);
  const safeTo = safeHeader(to);

  if (cfg.backend === "resend") {
    if (!cfg.resendApiKey) throw new Error("Resend API key not configured");
    const res = await safeFetchTrusted("https://api.resend.com/emails", {
      allowedHosts: ["api.resend.com"],
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: safeTo, subject: safeSubjectText, html }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `Resend send failed (${res.status})`);
    }
    return;
  }

  if (!cfg.smtpHost) throw new Error("SMTP host not configured");
  const smtpConfig = await buildSmtpConfig(cfg);
  await sendMail(smtpConfig, { from, to: safeTo, subject: safeSubjectText, html });
}

// Bounded fan-out (guardrail 31): on the SMTP backend every sendOne is a fresh
// DNS lookup + TCP/TLS connect + EHLO/STARTTLS/AUTH handshake, and relays cap
// concurrent connections per client IP (~10) — a bare Promise.all over every
// admin trips `421 Too many concurrent connections` on larger installs. Settle
// instead of race, too: Promise.all surfaces only the FIRST rejection, so a relay
// refusing most recipients looked like a single transient error in the log.
// The first failure is still rethrown so callers keep their throw-on-failure contract.
async function sendMany(cfg: EmailConfig, recipients: string[], subject: string, html: string): Promise<void> {
  const results = await settleLimit(recipients, 3, (addr) => sendOne(cfg, addr, subject, html));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 1) {
    // Log the count only — recipient addresses stay out of the logs.
    console.error(`[email] ${failures.length}/${recipients.length} recipients failed to send`);
  }
  if (failures.length > 0) throw failures[0].reason;
}

// Admin fan-out in each recipient's language: one render per locale present,
// then the bounded sendMany per group. Groups go out one after another so the
// SMTP concurrency cap holds across the whole fan-out; every group is attempted
// even when an earlier one failed, and the first failure is rethrown.
async function sendManyLocalized(
  cfg: EmailConfig,
  recipients: Recipient[],
  render: (lang: Lang) => { subject: string; html: string },
): Promise<void> {
  const groups = new Map<Locale, string[]>();
  for (const r of recipients) {
    const locale = localeForUser({ locale: r.locale });
    const list = groups.get(locale) ?? [];
    list.push(r.to);
    groups.set(locale, list);
  }
  let firstError: unknown = null;
  let failed = false;
  for (const [locale, to] of groups) {
    const { subject, html } = render({ t: translatorFor(locale), locale });
    try {
      await sendMany(cfg, to, subject, html);
    } catch (err) {
      if (!failed) firstError = err;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

// A newline (CR/LF) inside a header value would let an attacker add fake headers
// ("CRLF injection"), so strip newlines from any value that goes into a header.
function safeHeader(str: string): string {
  return str.replace(/[\r\n]+/g, " ");
}

async function getAdminEmails(excludeUserId?: string): Promise<Recipient[]> {
  // Bitmask authoritative: any holder of MANAGE_REQUESTS (or ADMIN superbit).
  // Includes custom-granted users; falls back correctly for legacy rows.
  const rows = await prisma.user.findMany({
    // Disabled accounts keep their role, permissions and email (guardrail 33 —
    // deactivateUserInTx writes exactly two fields), so without this they'd keep
    // receiving admin mail forever. A PURGED row is worse: its tombstone address
    // (deleted-<id>@deleted.invalid) hard-bounces on every send. This is the
    // admin-side chokepoint — the requester fan-out has its own two gates.
    where: { deactivatedAt: null, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    select: { email: true, notificationEmail: true, role: true, permissions: true, locale: true },
  });
  return rows
    .filter((u) => {
      const perms = effectivePermissions(u.role, parsePermissions(String(u.permissions ?? 0)));
      return hasPermission(perms, Permission.MANAGE_REQUESTS);
    })
    .flatMap((a) => {
      const to = resolveUserNotificationEmail(a);
      return to ? [{ to, locale: a.locale ?? null }] : [];
    });
}

// For issue-related admin emails: holders of MANAGE_ISSUES + notifyOnIssue.
// Bitmask authoritative so clearing the bit stops notifications; ADMIN always passes.
async function getIssueAdminEmails(opts: { excludeUserId?: string; restrictToUserId?: string } = {}): Promise<Recipient[]> {
  if (opts.restrictToUserId && opts.restrictToUserId === opts.excludeUserId) return [];
  const idFilter = opts.restrictToUserId
    ? { id: opts.restrictToUserId }
    : opts.excludeUserId
      ? { id: { not: opts.excludeUserId } }
      : {};
  const rows = await prisma.user.findMany({
    where: {
      notifyOnIssue: true,
      deactivatedAt: null, // see getAdminEmails
      ...idFilter,
    },
    select: { email: true, notificationEmail: true, role: true, permissions: true, locale: true },
  });
  return rows
    .filter((u) => {
      const perms = effectivePermissions(u.role, parsePermissions(String(u.permissions ?? 0)));
      return hasPermission(perms, Permission.MANAGE_ISSUES);
    })
    .flatMap((a) => {
      const to = resolveUserNotificationEmail(a);
      return to ? [{ to, locale: a.locale ?? null }] : [];
    });
}

// ─── Template ────────────────────────────────────────────────────────────────
//
// One shared dark-zinc template with an accent bar, optional poster artwork,
// a detail block, and an optional CTA button. All notifiers funnel through
// richEmailHtml() so the visual treatment stays consistent.

type Accent = "indigo" | "green" | "red" | "amber";

const ACCENTS: Record<Accent, { bar: string; button: string; buttonHover: string }> = {
  indigo: { bar: "#6366f1", button: "#6366f1", buttonHover: "#818cf8" },
  green:  { bar: "#22c55e", button: "#16a34a", buttonHover: "#22c55e" },
  red:    { bar: "#ef4444", button: "#dc2626", buttonHover: "#ef4444" },
  amber:  { bar: "#f59e0b", button: "#d97706", buttonHover: "#f59e0b" },
};

interface TemplateOpts {
  lang: Lang;
  preheader: string;
  accent: Accent;
  heading: string;
  subheading?: string;
  posterPath?: string | null;
  mediaType?: string;
  details?: Array<[label: string, value: string]>;
  bodyHtml?: string;
  ctaLabel?: string;
  ctaHref?: string;
  siteUrl?: string;
}

// TMDB serves poster art from a public CDN — no auth needed, w300 renders crisply at ~120px
function posterUrl(path?: string | null): string | null {
  if (!path) return null;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `https://image.tmdb.org/t/p/w300${clean}`;
}

function mediaAltText(t: Translator, mediaType?: string): string {
  if (mediaType === "MOVIE") return t("notify.email.posterAlt.movie");
  if (mediaType === "TV") return t("notify.email.posterAlt.tv");
  return t("notify.email.posterAlt.other");
}

function richEmailHtml(opts: TemplateOpts): string {
  const { t } = opts.lang;
  const accent = ACCENTS[opts.accent];
  const poster = posterUrl(opts.posterPath);

  const detailRowsHtml = opts.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
        ${opts.details.map(([l, v]) => detailRow(l, v)).join("")}
      </table>`
    : "";

  // Two-column poster layout collapses nicely in most clients; Outlook renders
  // the poster as an inline image-left block, which is acceptable.
  const contentBlock = poster
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
        <tr>
          <td valign="top" width="130" style="padding:0 20px 0 0">
            <img src="${esc(poster)}" width="120" alt="${esc(mediaAltText(t, opts.mediaType))}"
              style="display:block;width:120px;max-width:120px;height:auto;border-radius:8px;border:1px solid #3f3f46" />
          </td>
          <td valign="top" style="min-width:0">
            ${detailRowsHtml}
            ${opts.bodyHtml ?? ""}
          </td>
        </tr>
      </table>`
    : `${detailRowsHtml}${opts.bodyHtml ?? ""}`;

  const ctaHtml = opts.ctaLabel && opts.ctaHref
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px">
        <tr><td style="border-radius:8px;background:${accent.button}">
          <a href="${esc(opts.ctaHref)}"
            style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background:${accent.button}">
            ${esc(opts.ctaLabel)}
          </a>
        </td></tr>
      </table>`
    : "";

  const subheadingHtml = opts.subheading
    ? `<p style="margin:0 0 20px;font-size:14px;color:#a1a1aa;line-height:1.55">${opts.subheading}</p>`
    : "";

  const footerHtml = opts.siteUrl
    ? `<p style="margin:0;font-size:11px;color:#52525b;line-height:1.5">
        ${t("notify.email.footer", { brand: `<a href="${esc(opts.siteUrl)}" style="color:#71717a;text-decoration:none">Summonarr</a>` })}
      </p>`
    : `<p style="margin:0;font-size:11px;color:#52525b;line-height:1.5">${t("notify.email.footer", { brand: "Summonarr" })}</p>`;

  return `<!DOCTYPE html>
<html lang="${opts.lang.locale}">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <meta name="supported-color-schemes" content="dark"/>
  <title>${esc(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',ui-sans-serif,system-ui,sans-serif;color:#e4e4e7">
  <!-- Preheader: shown in inbox list previews, hidden in the body -->
  <div style="display:none;overflow:hidden;line-height:1px;max-height:0;max-width:0;opacity:0;mso-hide:all">
    ${esc(opts.preheader)}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#09090b">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:100%;max-width:560px;background:#18181b;border:1px solid #27272a;border-radius:14px;overflow:hidden">
          <!-- Accent bar + wordmark -->
          <tr>
            <td style="padding:18px 28px;background:#0f0f10;border-bottom:3px solid ${accent.bar}">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size:15px;font-weight:700;letter-spacing:-0.01em;color:#fafafa">
                    Summonarr
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Heading -->
          <tr>
            <td style="padding:28px 28px 8px">
              <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:700;color:#fafafa">
                ${esc(opts.heading)}
              </h1>
              ${subheadingHtml}
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:4px 28px 8px">
              ${contentBlock}
              ${ctaHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 28px 24px;border-top:1px solid #27272a">
              ${footerHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 14px 6px 0;color:#71717a;white-space:nowrap;vertical-align:top;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600">${label}</td>
    <td style="padding:6px 0;color:#e4e4e7;font-size:14px;line-height:1.5;vertical-align:top">${value}</td>
  </tr>`;
}

function buildSiteUrl(siteUrl: string | undefined, path: string): string | undefined {
  if (!siteUrl) return undefined;
  const trimmed = siteUrl.replace(/\/+$/, "");
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${prefixed}`;
}

function noteBlockHtml(note: string | null | undefined, label: string): string {
  if (!note) return "";
  return `<div style="margin-top:14px;padding:12px 14px;background:#1f1f23;border-left:3px solid #52525b;border-radius:6px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;color:#71717a;margin-bottom:4px">${esc(label)}</div>
    <div style="font-size:13px;color:#d4d4d8;line-height:1.5">${esc(note)}</div>
  </div>`;
}

// ─── Notifiers ──────────────────────────────────────────────────────────────

export async function notifyAdminsNewRequest(data: {
  title: string;
  mediaType: string;
  requestedBy: string;
  note: string | null;
  posterPath?: string | null;
  tmdbId?: number;
  releaseYear?: string | null;
  excludeUserId?: string;
}) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const to = await getAdminEmails(data.excludeUserId);
    if (!to.length) return;

    const titleWithYear = data.releaseYear ? `${data.title} (${data.releaseYear})` : data.title;
    await sendManyLocalized(cfg, to, (lang) => {
      const { t } = lang;
      const mediaLabel = mediaLabelT(t, data.mediaType);
      const html = richEmailHtml({
        lang,
        preheader: t("notify.email.newRequest.preheader", { user: data.requestedBy, media: mediaLabel.toLowerCase(), title: data.title }),
        accent: "indigo",
        heading: t("notify.email.newRequest.heading"),
        subheading: t("notify.email.newRequest.subheading", { media: mediaLabel.toLowerCase() }),
        posterPath: data.posterPath,
        mediaType: data.mediaType,
        details: [
          [t("notify.email.detail.title"), esc(titleWithYear)],
          [t("notify.email.detail.type"), mediaLabel],
          [t("notify.email.detail.requestedBy"), esc(data.requestedBy)],
        ],
        bodyHtml: noteBlockHtml(data.note, t("notify.email.note.note")),
        ctaLabel: t("notify.email.newRequest.cta"),
        ctaHref: buildSiteUrl(cfg.siteUrl, "/"),
        siteUrl: cfg.siteUrl,
      });
      return { subject: t("notify.email.newRequest.subject", { media: mediaLabel, title: data.title }), html };
    });
  } catch (err) {
    console.error("[email] Failed to send new request notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyAdminsNewIssue(data: {
  title: string;
  mediaType: string;
  issueType: string;
  reportedBy: string;
  note: string | null;
  posterPath?: string | null;
  issueId?: string;
  excludeUserId?: string;
}) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    // Issue managers (MANAGE_ISSUES) must get the new-issue email, matching the
    // push counterpart. getAdminEmails() picks request managers instead.
    const to = await getIssueAdminEmails({ excludeUserId: data.excludeUserId });
    if (!to.length) return;

    const ctaPath = data.issueId ? `/admin/issues?selected=${data.issueId}` : "/admin/issues";
    await sendManyLocalized(cfg, to, (lang) => {
      const { t } = lang;
      const mediaLabel = mediaLabelT(t, data.mediaType);
      const issueLabel = issueTypeLabelT(t, data.issueType);
      const html = richEmailHtml({
        lang,
        preheader: t("notify.email.newIssue.preheader", { user: data.reportedBy, issue: issueLabel.toLowerCase(), title: data.title }),
        accent: "amber",
        heading: t("notify.email.newIssue.heading"),
        subheading: t("notify.email.newIssue.subheading", { media: mediaLabel.toLowerCase() }),
        posterPath: data.posterPath,
        mediaType: data.mediaType,
        details: [
          [t("notify.email.detail.title"), esc(data.title)],
          [t("notify.email.detail.type"), mediaLabel],
          [t("notify.email.detail.issue"), esc(issueLabel)],
          [t("notify.email.detail.reportedBy"), esc(data.reportedBy)],
        ],
        bodyHtml: noteBlockHtml(data.note, t("notify.email.note.description")),
        ctaLabel: t("notify.email.newIssue.cta"),
        ctaHref: buildSiteUrl(cfg.siteUrl, ctaPath),
        siteUrl: cfg.siteUrl,
      });
      return { subject: t("notify.email.newIssue.subject", { title: data.title }), html };
    });
  } catch (err) {
    console.error("[email] Failed to send new issue notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyAdminsIssueMessageEmail(data: {
  issueTitle: string;
  userName: string;
  body: string;
  issueId: string;
  excludeUserId?: string;
  fromAdmin?: boolean;
  restrictToUserId?: string;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const to = await getIssueAdminEmails({
      excludeUserId: data.excludeUserId,
      restrictToUserId: data.restrictToUserId,
    });
    if (!to.length) return;

    await sendManyLocalized(cfg, to, (lang) => {
      const { t } = lang;
      const subject = data.fromAdmin
        ? t("notify.email.adminIssueMessage.subjectFromAdmin", { title: data.issueTitle })
        : t("notify.email.adminIssueMessage.subject", { title: data.issueTitle });
      const html = richEmailHtml({
        lang,
        preheader: t("notify.email.adminIssueMessage.preheader", { user: data.userName, title: data.issueTitle }),
        accent: "amber",
        heading: data.fromAdmin
          ? t("notify.email.adminIssueMessage.headingFromAdmin")
          : t("notify.email.adminIssueMessage.heading"),
        subheading: t("notify.email.adminIssueMessage.subheading", { user: esc(data.userName) }),
        details: [
          [t("notify.email.detail.issue"), esc(data.issueTitle)],
          [t("notify.email.detail.from"), esc(data.userName)],
        ],
        bodyHtml: noteBlockHtml(data.body, t("notify.email.note.message")),
        ctaLabel: t("notify.email.cta.viewIssue"),
        ctaHref: buildSiteUrl(cfg.siteUrl, `/admin/issues?selected=${data.issueId}`),
        siteUrl: cfg.siteUrl,
      });
      return { subject, html };
    });
  } catch (err) {
    console.error("[email] Failed to send admin issue-message notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserIssueMessageEmail(data: {
  toEmail: string;
  issueTitle: string;
  authorName: string;
  body: string;
  /** The recipient's stored User.locale (null → the instance default). */
  locale?: string | null;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const lang = langFor(data.locale);
    const { t } = lang;
    const subject = t("notify.email.userIssueMessage.subject", { title: data.issueTitle });
    const html = richEmailHtml({
      lang,
      preheader: t("notify.email.userIssueMessage.preheader", { user: data.authorName, title: data.issueTitle }),
      accent: "indigo",
      heading: t("notify.email.userIssueMessage.heading"),
      subheading: t("notify.email.userIssueMessage.subheading", { user: esc(data.authorName) }),
      details: [
        [t("notify.email.detail.issue"), esc(data.issueTitle)],
        [t("notify.email.detail.from"), esc(data.authorName)],
      ],
      bodyHtml: noteBlockHtml(data.body, t("notify.email.note.message")),
      ctaLabel: t("notify.email.cta.viewIssue"),
      ctaHref: buildSiteUrl(cfg.siteUrl, "/issues"),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, subject, html);
  } catch (err) {
    console.error("[email] Failed to send user issue-message notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserRequestApprovedEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
  posterPath?: string | null;
  tmdbId?: number;
  /** The recipient's stored User.locale (null → the instance default). */
  locale?: string | null;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const lang = langFor(data.locale);
    const { t } = lang;
    const mediaLabel = mediaLabelT(t, data.mediaType);
    const html = richEmailHtml({
      lang,
      preheader: t("notify.email.approved.preheader", { media: mediaLabel.toLowerCase(), title: data.title }),
      accent: "green",
      heading: t("notify.email.approved.heading"),
      subheading: t("notify.email.approved.subheading", { media: strong(mediaLabel), title: strong(esc(data.title)) }),
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      ctaLabel: t("notify.email.cta.viewRequests"),
      ctaHref: buildSiteUrl(cfg.siteUrl, "/requests"),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, t("notify.email.approved.subject", { media: mediaLabel, title: data.title }), html);
  } catch (err) {
    console.error("[email] Failed to send user approved notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserRequestDeclinedEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
  adminNote?: string | null;
  posterPath?: string | null;
  /** The recipient's stored User.locale (null → the instance default). */
  locale?: string | null;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const lang = langFor(data.locale);
    const { t } = lang;
    const mediaLabel = mediaLabelT(t, data.mediaType);
    const html = richEmailHtml({
      lang,
      preheader: t("notify.email.declined.preheader", { media: mediaLabel.toLowerCase(), title: data.title }),
      accent: "red",
      heading: t("notify.email.declined.heading"),
      subheading: t("notify.email.declined.subheading", { media: strong(mediaLabel), title: strong(esc(data.title)) }),
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      bodyHtml: noteBlockHtml(data.adminNote, t("notify.email.note.adminNote")),
      ctaLabel: t("notify.email.cta.viewRequests"),
      ctaHref: buildSiteUrl(cfg.siteUrl, "/requests"),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, t("notify.email.declined.subject", { media: mediaLabel, title: data.title }), html);
  } catch (err) {
    console.error("[email] Failed to send user declined notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserRequestAvailableEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
  posterPath?: string | null;
  tmdbId?: number;
  /** The recipient's stored User.locale (null → the instance default). */
  locale?: string | null;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const lang = langFor(data.locale);
    const { t } = lang;
    const mediaLabel = mediaLabelT(t, data.mediaType);
    const mediaSlug = data.mediaType === "MOVIE" ? "movie" : "tv";
    const deepLink = data.tmdbId ? `/${mediaSlug}/${data.tmdbId}` : "/requests";
    const html = richEmailHtml({
      lang,
      preheader: t("notify.email.available.preheader", { title: data.title }),
      accent: "green",
      heading: t("notify.email.available.heading"),
      subheading: t("notify.email.available.subheading", { media: strong(mediaLabel), title: strong(esc(data.title)) }),
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      ctaLabel: t("notify.email.available.cta"),
      ctaHref: buildSiteUrl(cfg.siteUrl, deepLink),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, t("notify.email.available.subject", { title: data.title }), html);
  } catch (err) {
    console.error("[email] Failed to send user available notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyAdminsDeletionVoteThreshold(data: {
  title: string;
  mediaType: string;
  voteCount: number;
  posterPath?: string | null;
  tmdbId?: number;
}) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    await sendManyLocalized(cfg, to, (lang) => {
      const { t } = lang;
      const mediaLabel = mediaLabelT(t, data.mediaType);
      const html = richEmailHtml({
        lang,
        preheader: t("notify.email.deletionVote.preheader", { votes: String(data.voteCount), title: data.title }),
        accent: "amber",
        heading: t("notify.email.deletionVote.heading"),
        subheading: t("notify.email.deletionVote.subheading", { media: mediaLabel.toLowerCase() }),
        posterPath: data.posterPath,
        mediaType: data.mediaType,
        details: [
          [t("notify.email.detail.title"), esc(data.title)],
          [t("notify.email.detail.type"), mediaLabel],
          [t("notify.email.detail.votes"), String(data.voteCount)],
        ],
        ctaLabel: t("notify.email.deletionVote.cta"),
        ctaHref: buildSiteUrl(cfg.siteUrl, "/votes"),
        siteUrl: cfg.siteUrl,
      });
      return { subject: t("notify.email.deletionVote.subject", { title: data.title }), html };
    });
  } catch (err) {
    console.error("[email] Failed to send deletion vote threshold notification:", err instanceof Error ? err.message : err);
  }
}

// Account-security notice (two-factor changed / locked). Best-effort like every
// notifier here: gated on the same email switch, never throws. Plain text only
// in `message` — it is escaped, so no caller can inject markup.
export async function notifyUserSecurityEventEmail(data: {
  toEmail: string;
  subject: string;
  heading: string;
  message: string;
  /** The recipient's stored User.locale (null → the instance default). */
  locale?: string | null;
}): Promise<void> {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const lang = langFor(data.locale);
    const { t } = lang;
    const html = richEmailHtml({
      lang,
      preheader: data.message,
      accent: "amber",
      heading: esc(data.heading),
      subheading: t("notify.email.security.subheading", { message: esc(data.message) }),
      ctaLabel: cfg.siteUrl ? t("notify.email.security.cta") : undefined,
      ctaHref: cfg.siteUrl ? buildSiteUrl(cfg.siteUrl, "/profile#two-factor") : undefined,
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, data.subject, html);
  } catch (err) {
    console.error("[email] Failed to send security notification:", err instanceof Error ? err.message : err);
  }
}

// `locale` is the language to write the test email in (the settings route passes
// the requesting admin's); omitted → the instance default.
export async function sendTestEmail(to: string, locale?: string | null): Promise<void> {
  // Bypass the send toggle (but not the feature flag) so admins can verify the
  // SMTP/Resend transport before switching notification emails on.
  const cfg = await getEmailConfig({ ignoreSendToggle: true });
  if (!cfg) throw new Error("Email integration is disabled");
  if (!isBackendConfigured(cfg)) {
    throw new Error(cfg.backend === "resend" ? "Resend API key not configured" : "SMTP not configured");
  }
  const lang = langFor(locale);
  const { t } = lang;
  const html = richEmailHtml({
    lang,
    preheader: t("notify.email.test.preheader"),
    accent: "indigo",
    heading: t("notify.email.test.heading"),
    subheading: t("notify.email.test.subheading", { backend: strong(cfg.backend === "resend" ? "Resend" : "SMTP") }),
    ctaLabel: cfg.siteUrl ? t("notify.email.test.cta") : undefined,
    ctaHref: cfg.siteUrl ? buildSiteUrl(cfg.siteUrl, "/") : undefined,
    siteUrl: cfg.siteUrl,
  });
  await sendOne(cfg, to, t("notify.email.test.subject"), html);
}

// Mails a one-time verification link to `to` for the Jellyfin self-service
// notification-email flow. Throws when no transport is configured (the route
// surfaces that to the user). The raw token travels only in this link.
// `locale` is the language to write it in (the route passes the requesting
// user's); omitted → the instance default.
export async function sendNotificationEmailVerification(to: string, token: string, locale?: string | null): Promise<void> {
  const cfg = await getEmailConfig();
  if (!cfg || !isBackendConfigured(cfg)) {
    throw new Error("Email transport is not configured on this server");
  }
  const base = (cfg.siteUrl || process.env.AUTH_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("No site URL is configured for the verification link");
  const verifyUrl = `${base}/api/profile/notification-email/confirm?token=${encodeURIComponent(token)}`;
  const lang = langFor(locale);
  const { t } = lang;
  const html = richEmailHtml({
    lang,
    preheader: t("notify.email.verify.preheader"),
    accent: "indigo",
    heading: t("notify.email.verify.heading"),
    subheading: t("notify.email.verify.subheading"),
    ctaLabel: t("notify.email.verify.cta"),
    ctaHref: verifyUrl,
    siteUrl: cfg.siteUrl,
  });
  await sendOne(cfg, to, t("notify.email.verify.subject"), html);
}

// Emphasis inside a subheading. The value must already be HTML-safe.
function strong(html: string): string {
  return `<strong style="color:#fafafa">${html}</strong>`;
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeSubject(str: string): string {
  return str.replace(/[\r\n]+/g, " ");
}

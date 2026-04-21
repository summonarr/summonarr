import nodemailer from "nodemailer";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { resolveUserNotificationEmail } from "@/lib/notification-email";

// Keys read from the Setting table. `emailBackend` picks the transport:
//   - "resend" → Resend HTTP API (`resend` npm package)
//   - "smtp"   → nodemailer SMTP (legacy default when unset)
// Resend sender falls back to smtpFrom so users sharing one from-address
// don't have to enter it twice. siteUrl is read so CTAs can link to the app.
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

async function getEmailConfig(): Promise<EmailConfig | null> {
  if (!(await isFeatureEnabled("feature.integration.email"))) return null;
  const rows = await prisma.setting.findMany({ where: { key: { in: [...EMAIL_KEYS] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, string | undefined>;
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

function resolveFromAddress(cfg: EmailConfig): string {
  if (cfg.backend === "resend") {
    return safeHeader(cfg.resendFrom || cfg.smtpFrom || "summonarr@localhost");
  }
  return safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
}

function createTransport(cfg: EmailConfig) {
  const port = parseInt(cfg.smtpPort ?? "587", 10);
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port,
    secure: port === 465,
    // requireTLS enforces STARTTLS on port 587 but must be skipped for localhost (plaintext dev/test relay)
    requireTLS: !cfg.smtpHost?.match(/^localhost$/i) && port === 587,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword ?? "" } : undefined,
  });
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
    const resend = new Resend(cfg.resendApiKey);
    const { error } = await resend.emails.send({ from, to: safeTo, subject: safeSubjectText, html });
    if (error) throw new Error(error.message ?? "Resend send failed");
    return;
  }

  if (!cfg.smtpHost) throw new Error("SMTP host not configured");
  await createTransport(cfg).sendMail({ from, to: safeTo, subject: safeSubjectText, html });
}

async function sendMany(cfg: EmailConfig, recipients: string[], subject: string, html: string): Promise<void> {
  await Promise.all(recipients.map((addr) => sendOne(cfg, addr, subject, html)));
}

// CRLF injection in email headers can forge From/Subject — strip newlines from any value that goes into a header
function safeHeader(str: string): string {
  return str.replace(/[\r\n]+/g, " ");
}

async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { email: true, notificationEmail: true },
  });
  return admins
    .map((a) => resolveUserNotificationEmail(a))
    .filter((e): e is string => Boolean(e));
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

function mediaAltText(mediaType?: string): string {
  if (mediaType === "MOVIE") return "Movie poster";
  if (mediaType === "TV") return "TV show poster";
  return "Poster";
}

function richEmailHtml(opts: TemplateOpts): string {
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
            <img src="${poster}" width="120" alt="${esc(mediaAltText(opts.mediaType))}"
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
        Sent by <a href="${esc(opts.siteUrl)}" style="color:#71717a;text-decoration:none">Summonarr</a>
      </p>`
    : `<p style="margin:0;font-size:11px;color:#52525b;line-height:1.5">Sent by Summonarr</p>`;

  return `<!DOCTYPE html>
<html lang="en">
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

function mediaLabelOf(mediaType: string): string {
  return mediaType === "MOVIE" ? "Movie" : "TV Show";
}

function noteBlockHtml(note: string | null | undefined, label = "Note"): string {
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
}) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    const mediaLabel = mediaLabelOf(data.mediaType);
    const subject = `New ${mediaLabel} Request: ${data.title}`;
    const titleWithYear = data.releaseYear ? `${data.title} (${data.releaseYear})` : data.title;
    const html = richEmailHtml({
      preheader: `${data.requestedBy} requested ${mediaLabel.toLowerCase()}: ${data.title}`,
      accent: "indigo",
      heading: "New Request",
      subheading: `A user submitted a new ${mediaLabel.toLowerCase()} request.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      details: [
        ["Title", esc(titleWithYear)],
        ["Type", mediaLabel],
        ["Requested by", esc(data.requestedBy)],
      ],
      bodyHtml: noteBlockHtml(data.note),
      ctaLabel: "Review in Summonarr",
      ctaHref: buildSiteUrl(cfg.siteUrl, "/"),
      siteUrl: cfg.siteUrl,
    });
    await sendMany(cfg, to, subject, html);
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
}) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    const mediaLabel = mediaLabelOf(data.mediaType);
    const issueLabel = data.issueType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const subject = `New Issue Report: ${data.title}`;
    const ctaPath = data.issueId ? `/admin/issues/${data.issueId}` : "/admin/issues";
    const html = richEmailHtml({
      preheader: `${data.reportedBy} reported a ${issueLabel.toLowerCase()} issue on ${data.title}`,
      accent: "amber",
      heading: "New Issue Report",
      subheading: `A user flagged a problem with a ${mediaLabel.toLowerCase()}.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      details: [
        ["Title", esc(data.title)],
        ["Type", mediaLabel],
        ["Issue", esc(issueLabel)],
        ["Reported by", esc(data.reportedBy)],
      ],
      bodyHtml: noteBlockHtml(data.note, "Description"),
      ctaLabel: "Review Issue",
      ctaHref: buildSiteUrl(cfg.siteUrl, ctaPath),
      siteUrl: cfg.siteUrl,
    });
    await sendMany(cfg, to, subject, html);
  } catch (err) {
    console.error("[email] Failed to send new issue notification:", err instanceof Error ? err.message : err);
  }
}

async function isUserEmailsEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: "enableUserEmails" } });
  return row?.value === "true";
}

export async function notifyUserRequestApprovedEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
  posterPath?: string | null;
  tmdbId?: number;
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const mediaLabel = mediaLabelOf(data.mediaType);
    const html = richEmailHtml({
      preheader: `Your ${mediaLabel.toLowerCase()} request for ${data.title} was approved.`,
      accent: "green",
      heading: "Request Approved",
      subheading: `Your <strong style="color:#fafafa">${mediaLabel}</strong> request for <strong style="color:#fafafa">${esc(data.title)}</strong> has been approved and is being added to the library.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      ctaLabel: "View Your Requests",
      ctaHref: buildSiteUrl(cfg.siteUrl, "/requests"),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, `Your ${mediaLabel} Request Was Approved: ${data.title}`, html);
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
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const mediaLabel = mediaLabelOf(data.mediaType);
    const html = richEmailHtml({
      preheader: `Your ${mediaLabel.toLowerCase()} request for ${data.title} was declined.`,
      accent: "red",
      heading: "Request Declined",
      subheading: `Your <strong style="color:#fafafa">${mediaLabel}</strong> request for <strong style="color:#fafafa">${esc(data.title)}</strong> was not approved.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      bodyHtml: noteBlockHtml(data.adminNote, "Note from admin"),
      ctaLabel: "View Your Requests",
      ctaHref: buildSiteUrl(cfg.siteUrl, "/requests"),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, `Your ${mediaLabel} Request Was Declined: ${data.title}`, html);
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
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getEmailConfig();
    if (!cfg || !isBackendConfigured(cfg)) return;
    const mediaLabel = mediaLabelOf(data.mediaType);
    const mediaSlug = data.mediaType === "MOVIE" ? "movie" : "tv";
    const deepLink = data.tmdbId ? `/${mediaSlug}/${data.tmdbId}` : "/requests";
    const html = richEmailHtml({
      preheader: `${data.title} is ready to watch on Summonarr.`,
      accent: "green",
      heading: "Now Available",
      subheading: `Your <strong style="color:#fafafa">${mediaLabel}</strong> request for <strong style="color:#fafafa">${esc(data.title)}</strong> is ready to watch.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      ctaLabel: "Start Watching",
      ctaHref: buildSiteUrl(cfg.siteUrl, deepLink),
      siteUrl: cfg.siteUrl,
    });
    await sendOne(cfg, data.toEmail, `Now Available: ${data.title}`, html);
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

    const mediaLabel = mediaLabelOf(data.mediaType);
    const subject = `Deletion Vote Threshold Reached: ${data.title}`;
    const html = richEmailHtml({
      preheader: `${data.voteCount} users voted to remove ${data.title}.`,
      accent: "amber",
      heading: "Deletion Vote Threshold Reached",
      subheading: `Enough users have voted to remove this ${mediaLabel.toLowerCase()} from the library.`,
      posterPath: data.posterPath,
      mediaType: data.mediaType,
      details: [
        ["Title", esc(data.title)],
        ["Type", mediaLabel],
        ["Votes", String(data.voteCount)],
      ],
      ctaLabel: "Review Votes",
      ctaHref: buildSiteUrl(cfg.siteUrl, "/votes"),
      siteUrl: cfg.siteUrl,
    });
    await sendMany(cfg, to, subject, html);
  } catch (err) {
    console.error("[email] Failed to send deletion vote threshold notification:", err instanceof Error ? err.message : err);
  }
}

export async function sendTestEmail(to: string): Promise<void> {
  const cfg = await getEmailConfig();
  if (!cfg) throw new Error("Email integration is disabled");
  if (!isBackendConfigured(cfg)) {
    throw new Error(cfg.backend === "resend" ? "Resend API key not configured" : "SMTP not configured");
  }
  const html = richEmailHtml({
    preheader: "Your Summonarr email configuration is working.",
    accent: "indigo",
    heading: "Test Email",
    subheading: `Your Summonarr email configuration is working correctly. Delivered via <strong style="color:#fafafa">${cfg.backend === "resend" ? "Resend" : "SMTP"}</strong>.`,
    ctaLabel: cfg.siteUrl ? "Open Summonarr" : undefined,
    ctaHref: cfg.siteUrl ? buildSiteUrl(cfg.siteUrl, "/") : undefined,
    siteUrl: cfg.siteUrl,
  });
  await sendOne(cfg, to, "Summonarr — Test Email", html);
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeSubject(str: string): string {
  return str.replace(/[\r\n]+/g, " ");
}

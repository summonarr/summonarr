import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { resolveUserNotificationEmail } from "@/lib/notification-email";

const SMTP_KEYS = ["smtpHost", "smtpPort", "smtpUser", "smtpPassword", "smtpFrom"] as const;

async function getSmtpConfig(): Promise<Record<string, string>> {
  if (!(await isFeatureEnabled("feature.integration.email"))) return {};
  const rows = await prisma.setting.findMany({ where: { key: { in: [...SMTP_KEYS] } } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function createTransport(cfg: Record<string, string>) {
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

export async function notifyAdminsNewRequest(data: {
  title: string;
  mediaType: string;
  requestedBy: string;
  note: string | null;
}) {
  try {
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const mediaLabel = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const transport = createTransport(cfg);
    const subject = safeSubject(`New ${mediaLabel} Request: ${data.title}`);
    const html = requestEmailHtml({ ...data, mediaLabel });

    await Promise.all(to.map((addr) => transport.sendMail({ from, to: safeHeader(addr), subject, html })));
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
}) {
  try {
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const transport = createTransport(cfg);
    const subject = safeSubject(`New Issue Report: ${data.title}`);
    const html = issueEmailHtml(data);
    await Promise.all(to.map((addr) => transport.sendMail({ from, to: safeHeader(addr), subject, html })));
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
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;
    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    await createTransport(cfg).sendMail({
      from,
      to: safeHeader(data.toEmail),
      subject: safeSubject(`Your ${label} Request Was Approved: ${data.title}`),
      html: emailWrapper(`
        <h2 style="margin:0 0 12px;color:#fff;font-size:18px">Request Approved ✅</h2>
        <p style="margin:0;color:#a1a1aa;font-size:14px">
          Your <strong style="color:#fff">${label}</strong> request for
          <strong style="color:#fff">${esc(data.title)}</strong> has been approved
          and is being added to the library.
        </p>`),
    });
  } catch (err) {
    console.error("[email] Failed to send user approved notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserRequestDeclinedEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
  adminNote?: string | null;
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;
    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const notePart = data.adminNote
      ? `<p style="margin:12px 0 0;font-size:13px;color:#a1a1aa"><strong style="color:#fff">Note from admin:</strong> ${esc(data.adminNote)}</p>`
      : "";
    await createTransport(cfg).sendMail({
      from,
      to: safeHeader(data.toEmail),
      subject: safeSubject(`Your ${label} Request Was Declined: ${data.title}`),
      html: emailWrapper(`
        <h2 style="margin:0 0 12px;color:#fff;font-size:18px">Request Declined</h2>
        <p style="margin:0;color:#a1a1aa;font-size:14px">
          Your <strong style="color:#fff">${label}</strong> request for
          <strong style="color:#fff">${esc(data.title)}</strong> was not approved.
        </p>${notePart}`),
    });
  } catch (err) {
    console.error("[email] Failed to send user declined notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyUserRequestAvailableEmail(data: {
  toEmail: string;
  title: string;
  mediaType: string;
}): Promise<void> {
  try {
    if (!(await isUserEmailsEnabled())) return;
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;
    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    await createTransport(cfg).sendMail({
      from,
      to: safeHeader(data.toEmail),
      subject: safeSubject(`Now Available: ${data.title}`),
      html: emailWrapper(`
        <h2 style="margin:0 0 12px;color:#fff;font-size:18px">Now Available 🎉</h2>
        <p style="margin:0;color:#a1a1aa;font-size:14px">
          Your <strong style="color:#fff">${label}</strong> request for
          <strong style="color:#fff">${esc(data.title)}</strong> is now available to watch!
        </p>`),
    });
  } catch (err) {
    console.error("[email] Failed to send user available notification:", err instanceof Error ? err.message : err);
  }
}

export async function notifyAdminsDeletionVoteThreshold(data: {
  title: string;
  mediaType: string;
  voteCount: number;
}) {
  try {
    const cfg = await getSmtpConfig();
    if (!cfg.smtpHost) return;

    const to = await getAdminEmails();
    if (!to.length) return;

    const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const transport = createTransport(cfg);
    const subject = safeSubject(`Deletion Vote Threshold Reached: ${data.title}`);
    const html = emailWrapper(`
        <h2 style="margin:0 0 16px;font-size:18px;color:#fff">Deletion Vote Threshold Reached</h2>
        <table style="border-collapse:collapse">${row("Title", esc(data.title))}${row("Type", label)}${row("Votes", String(data.voteCount))}</table>
        <p style="margin:16px 0 0;font-size:13px;color:#a1a1aa">Review this item in the Vote to Delete page.</p>
      `);
    await Promise.all(to.map((addr) => transport.sendMail({ from, to: safeHeader(addr), subject, html })));
  } catch (err) {
    console.error("[email] Failed to send deletion vote threshold notification:", err instanceof Error ? err.message : err);
  }
}

export async function sendTestEmail(to: string): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg.smtpHost) throw new Error("SMTP not configured");

  const from = safeHeader(cfg.smtpFrom || cfg.smtpUser || "summonarr@localhost");
  await createTransport(cfg).sendMail({
    from,
    to: safeHeader(to),
    subject: "Summonarr — Test Email",
    html: testEmailHtml(),
  });
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeSubject(str: string): string {
  return str.replace(/[\r\n]+/g, " ");
}

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#18181b;color:#e4e4e7;margin:0;padding:32px 16px">
  <div style="max-width:500px;margin:0 auto;background:#27272a;border-radius:12px;padding:28px 32px">
    ${content}
    <p style="margin:28px 0 0;font-size:11px;color:#52525b">Sent by Summonarr</p>
  </div>
</body>
</html>`;
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:5px 16px 5px 0;color:#a1a1aa;white-space:nowrap;vertical-align:top;font-size:13px">${label}</td>
    <td style="padding:5px 0;color:#fff;font-size:13px">${value}</td>
  </tr>`;
}

function requestEmailHtml({ title, mediaLabel, requestedBy, note }: {
  title: string;
  mediaLabel: string;
  requestedBy: string;
  note: string | null;
}): string {
  return emailWrapper(`
    <h2 style="margin:0 0 20px;color:#fff;font-size:18px">New ${mediaLabel} Request</h2>
    <table style="border-collapse:collapse;width:100%">
      ${row("Title", esc(title))}
      ${row("Type", mediaLabel)}
      ${row("Requested by", esc(requestedBy))}
      ${note ? row("Note", esc(note)) : ""}
    </table>`);
}

function issueEmailHtml({ title, mediaType, issueType, reportedBy, note }: {
  title: string;
  mediaType: string;
  issueType: string;
  reportedBy: string;
  note: string | null;
}): string {
  const mediaLabel = mediaType === "MOVIE" ? "Movie" : "TV Show";
  const issueLabel = esc(issueType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));

  return emailWrapper(`
    <h2 style="margin:0 0 20px;color:#fff;font-size:18px">New Issue Report</h2>
    <table style="border-collapse:collapse;width:100%">
      ${row("Title", esc(title))}
      ${row("Type", mediaLabel)}
      ${row("Issue", issueLabel)}
      ${row("Reported by", esc(reportedBy))}
      ${note ? row("Note", esc(note)) : ""}
    </table>`);
}

function testEmailHtml(): string {
  return emailWrapper(`
    <h2 style="margin:0 0 8px;color:#fff;font-size:18px">Test Email</h2>
    <p style="margin:0;color:#a1a1aa;font-size:14px">Your Summonarr email configuration is working correctly.</p>`);
}

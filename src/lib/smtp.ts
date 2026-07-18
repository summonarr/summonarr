import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { randomBytes } from "node:crypto";

// Minimal pure-TypeScript SMTP client used by [src/lib/email.ts](src/lib/email.ts).
//
// Why in-tree instead of an SMTP library:
//   - The SMTP feature set we actually need is small: EHLO, optional STARTTLS,
//     AUTH PLAIN/LOGIN, and a single-recipient text/html message.
//   - The DNS-rebind defense in email.ts pre-resolves the host to a literal IP
//     and hands that to the TCP layer while keeping the original hostname for
//     SNI + cert validation. Coordinating that (TCP target = IP, TLS servername
//     = original host) is clearer when we own the connect ourselves.
//
// Spec references: RFC 5321 (SMTP), RFC 4954 (AUTH), RFC 3207 (STARTTLS),
// RFC 5322 (message format), RFC 2045/2047 (MIME / encoded-word).

export interface SmtpConfig {
  /** ORIGINAL hostname (for SNI + cert validation). */
  host: string;
  /** Pre-validated IP literal (used for the TCP connect — defends against DNS rebind). */
  resolvedAddress: string;
  port: number;
  /** true → implicit TLS (port 465 wrap). */
  secure: boolean;
  /** true → require STARTTLS upgrade on the plaintext channel. */
  requireTLS: boolean;
  /**
   * Permit AUTH over an UNENCRYPTED channel. Only ever set for the localhost
   * dev/test-relay carve-out (see email.ts). Without it, sendMail refuses to
   * transmit credentials on a plaintext socket even when the server advertises
   * AUTH — base64 is not encryption, and a non-587 port (25/2525) otherwise
   * gets `secure=false, requireTLS=false` and would leak the password to any
   * on-path observer.
   */
  allowPlaintextAuth?: boolean;
  auth?: { user: string; pass: string };
}

export interface SmtpMessage {
  /** Single address, may include display name. */
  from: string;
  /** Single address. */
  to: string;
  subject: string;
  html: string;
}

export class SmtpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
  }
}

const READ_TIMEOUT_MS = 30_000;
const NUL = Buffer.from([0]);

// ─── Address helpers ────────────────────────────────────────────────────────

// Strip CR/LF (and NUL) from address fields before they reach header lines or
// the SMTP envelope — a raw CRLF in From/To would otherwise inject arbitrary
// message headers (via buildMessage) or SMTP commands (via MAIL FROM/RCPT TO).
// The sole current caller (email.ts sendOne) already strips newlines with
// safeHeader(); this is defense-in-depth at the layer that writes the wire
// format, matching the protection encodeSubject already gives the Subject line
// (non-printable input goes through the RFC 2047 base64 path).
function sanitizeAddressField(addr: string): string {
  return addr.replace(/[\r\n\0]/g, "");
}

// Extract the bare addr-spec from `"Name" <addr@host>` or `addr@host`.
// SMTP envelope (MAIL FROM, RCPT TO) requires just `<addr@host>`.
function extractAddrSpec(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  if (m) return m[1].trim();
  return addr.trim();
}

function extractDomain(addr: string): string {
  const spec = extractAddrSpec(addr);
  const at = spec.lastIndexOf("@");
  if (at === -1) return "summonarr.local";
  const domain = spec.slice(at + 1);
  return domain || "summonarr.local";
}

// EHLO requires a domain-shaped argument. Use the OS hostname when it looks
// FQDN-ish, otherwise fall back to a placeholder. Some MTAs reject EHLO with
// a single-label hostname (e.g. "macbook").
function ehloName(): string {
  const h = os.hostname();
  if (h && h.includes(".")) return h;
  return "summonarr.local";
}

// ─── MIME helpers ───────────────────────────────────────────────────────────

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

// RFC 2047 encoded-word (Base64) for non-ASCII subjects.
function encodeSubject(subject: string): string {
  if (ASCII_PRINTABLE.test(subject)) return subject;
  const b64 = Buffer.from(subject, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

// RFC 5322 date. `toUTCString()` returns "Tue, 01 Jan 2024 00:00:00 GMT"; SMTP
// canonical form prefers the numeric zone, so we swap GMT → +0000.
function rfc5322Date(): string {
  return new Date().toUTCString().replace(/GMT$/, "+0000");
}

// Quoted-printable per RFC 2045 §6.7.
// Rules implemented:
//   - Bytes 0x00-0x1F (except TAB 0x09) and 0x7F-0xFF → =XX hex
//   - "=" (0x3D) → =3D
//   - Trailing whitespace on a line is encoded (we apply this defensively to
//     any space/tab immediately before a CRLF)
//   - Soft line breaks: lines wrap at 76 chars with "=\r\n"
//   - Hard line breaks: original CRLF in input is preserved as CRLF
function encodeQuotedPrintable(input: string): string {
  const buf = Buffer.from(input, "utf8");
  // First pass: byte-level encoding. We split on the *input* CRLFs so each
  // logical line can be wrapped independently.
  const lines: string[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    // Detect CRLF in the source bytes — input may already be CRLF or LF-terminated.
    if (buf[i] === 0x0a) {
      // Consume optional preceding 0x0d
      const end = i > 0 && buf[i - 1] === 0x0d ? i - 1 : i;
      lines.push(encodeQpLineBytes(buf.subarray(lineStart, end)));
      lineStart = i + 1;
    }
  }
  if (lineStart < buf.length) {
    lines.push(encodeQpLineBytes(buf.subarray(lineStart)));
  }
  return lines.join("\r\n");
}

function encodeQpLineBytes(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isTrailingWhitespace =
      (b === 0x20 || b === 0x09) && i === bytes.length - 1;
    if (isTrailingWhitespace) {
      out += b === 0x20 ? "=20" : "=09";
      continue;
    }
    if (b === 0x09 || b === 0x20) {
      out += String.fromCharCode(b);
      continue;
    }
    if (b === 0x3d) {
      out += "=3D";
      continue;
    }
    if (b >= 0x21 && b <= 0x7e) {
      out += String.fromCharCode(b);
      continue;
    }
    // Control char or 8-bit byte → encode
    out += "=" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  // Wrap at 76 chars with "=\r\n" soft breaks. A soft break must not split
  // an encoded token (=XX), so back up if we'd land in the middle of one.
  return softWrapQp(out);
}

function softWrapQp(line: string): string {
  if (line.length <= 76) return line;
  const chunks: string[] = [];
  let i = 0;
  while (line.length - i > 76) {
    // Wrap point — we use `=` + CRLF (1 + 2 chars), so the printable portion
    // can be at most 75 chars to keep total ≤ 76 including the trailing `=`.
    let wrapAt = i + 75;
    // Don't split an `=XX` triplet. If the char at wrapAt-1 or wrapAt-2 is `=`,
    // back up to before that `=`.
    if (line[wrapAt - 1] === "=") wrapAt -= 1;
    else if (line[wrapAt - 2] === "=") wrapAt -= 2;
    chunks.push(line.slice(i, wrapAt) + "=");
    i = wrapAt;
  }
  chunks.push(line.slice(i));
  return chunks.join("\r\n");
}

// RFC 5321 §4.5.2 — any DATA line beginning with `.` must be dot-stuffed so
// the receiving SMTP server doesn't misinterpret it as end-of-message.
function dotStuff(body: string): string {
  // Apply line-by-line. Body is already CRLF-separated from encodeQuotedPrintable.
  return body
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

// ─── Socket helpers ─────────────────────────────────────────────────────────

interface SmtpReply {
  code: number;
  text: string;
  capabilities: string[];
}

// Pump bytes from the socket through a small state machine. SMTP replies are
// CRLF-terminated lines; a multi-line response uses `<code>-<text>` for all
// but the last line, which uses `<code> <text>`. We accumulate until the
// space-form arrives, then resolve.
class SmtpConnection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: ((value: SmtpReply | Error) => void) | null = null;
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private closed = false;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attachListeners();
  }

  private attachListeners(): void {
    this.dataListener = (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.tryResolve();
    };
    this.errorListener = (err: Error) => {
      this.closed = true;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p(err);
      }
    };
    this.closeListener = () => {
      this.closed = true;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p(new SmtpError("SMTP connection closed unexpectedly"));
      }
    };
    this.socket.on("data", this.dataListener);
    this.socket.on("error", this.errorListener);
    this.socket.on("close", this.closeListener);
  }

  private detachListeners(): void {
    if (this.dataListener) this.socket.off("data", this.dataListener);
    if (this.errorListener) this.socket.off("error", this.errorListener);
    if (this.closeListener) this.socket.off("close", this.closeListener);
    this.dataListener = null;
    this.errorListener = null;
    this.closeListener = null;
  }

  private tryResolve(): void {
    if (!this.pending) return;
    const idx = this.findCompleteReplyEnd();
    if (idx === -1) return;
    const raw = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx);
    const reply = parseReply(raw);
    const p = this.pending;
    this.pending = null;
    p(reply);
  }

  // Locate the end-of-response: the first line that starts with `<code> ` (3 digits
  // followed by space) terminated by CRLF. Returns the index *after* that CRLF,
  // or -1 if no complete response is buffered yet.
  private findCompleteReplyEnd(): number {
    let from = 0;
    while (true) {
      const eol = this.buffer.indexOf("\r\n", from);
      if (eol === -1) return -1;
      const line = this.buffer.slice(from, eol);
      // A final line is `\d{3} …` (space after the code); continuation is `\d{3}-…`.
      if (/^\d{3} /.test(line)) return eol + 2;
      from = eol + 2;
    }
  }

  async readReply(): Promise<SmtpReply> {
    if (this.closed) throw new SmtpError("SMTP connection is closed");
    return new Promise<SmtpReply>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        timer = null;
        this.pending = null;
        try {
          this.socket.destroy(new Error("SMTP read timeout"));
        } catch {
          // socket may already be destroyed
        }
        reject(new SmtpError(`SMTP read timed out after ${READ_TIMEOUT_MS}ms`));
      }, READ_TIMEOUT_MS);

      this.pending = (result) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      // Drain anything already buffered before this read was scheduled.
      this.tryResolve();
    });
  }

  async send(line: string): Promise<void> {
    if (this.closed) throw new SmtpError("SMTP connection is closed");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(line, "utf8", (err) => (err ? reject(err) : resolve()));
    });
  }

  async upgradeToTls(host: string): Promise<void> {
    // Detach plaintext listeners — the upgraded socket emits its own events.
    this.detachListeners();
    const plain = this.socket;
    const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: host }, () => {
        s.off("error", onError);
        resolve(s);
      });
      const onError = (err: Error) => reject(err);
      s.once("error", onError);
    });
    this.socket = tlsSocket;
    this.buffer = "";
    this.attachListeners();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachListeners();
    try {
      this.socket.end();
    } catch {
      // ignore
    }
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}

function parseReply(raw: string): SmtpReply {
  const lines = raw.split("\r\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { code: 0, text: "", capabilities: [] };
  }
  const first = lines[0];
  const code = parseInt(first.slice(0, 3), 10) || 0;
  const text = lines.map((l) => l.slice(4)).join("\n");
  // EHLO capability lines: everything after the first line is a capability token.
  const capabilities = lines.slice(1).map((l) => l.slice(4));
  return { code, text, capabilities };
}

function expectCode(reply: SmtpReply, ...wanted: number[]): void {
  if (!wanted.includes(reply.code)) {
    throw new SmtpError(`SMTP server returned ${reply.code}: ${reply.text}`, reply.code);
  }
}

function hasCapability(caps: string[], name: string): boolean {
  const upper = name.toUpperCase();
  return caps.some((c) => c.toUpperCase().split(/\s+/)[0] === upper);
}

function authMechanisms(caps: string[]): string[] {
  // Look for `AUTH <mech> <mech> …` capability and split off the rest.
  for (const c of caps) {
    const u = c.toUpperCase();
    if (u.startsWith("AUTH ") || u.startsWith("AUTH\t")) {
      return u
        .slice(5)
        .trim()
        .split(/\s+/);
    }
    if (u === "AUTH") return [];
  }
  return [];
}

// SASL PLAIN payload: authzid NUL authcid NUL password (RFC 4616). authzid is
// empty. Built via Buffer.concat with an explicit NUL so the source file never
// has to embed a literal U+0000.
function buildAuthPlainToken(user: string, pass: string): string {
  return Buffer.concat([
    NUL,
    Buffer.from(user, "utf8"),
    NUL,
    Buffer.from(pass, "utf8"),
  ]).toString("base64");
}

// ─── Connect ────────────────────────────────────────────────────────────────

async function connectSocket(config: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  if (config.secure) {
    // Implicit TLS (port 465). TCP target is the pre-validated IP; cert
    // validation uses the original hostname via `servername`.
    return new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        { host: config.resolvedAddress, port: config.port, servername: config.host },
        () => {
          socket.off("error", onError);
          resolve(socket);
        },
      );
      const onError = (err: Error) => reject(err);
      socket.once("error", onError);
    });
  }
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: config.resolvedAddress, port: config.port }, () => {
      socket.off("error", onError);
      resolve(socket);
    });
    const onError = (err: Error) => reject(err);
    socket.once("error", onError);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function sendMail(config: SmtpConfig, msg: SmtpMessage): Promise<void> {
  // Single choke point for the CRLF-injection defense: everything below —
  // extractAddrSpec (envelope), extractDomain (Message-ID), and buildMessage
  // (From:/To: header lines) — reads from this sanitized copy.
  msg = { ...msg, from: sanitizeAddressField(msg.from), to: sanitizeAddressField(msg.to) };
  const socket = await connectSocket(config);
  const conn = new SmtpConnection(socket);

  try {
    // 1. Greeting
    expectCode(await conn.readReply(), 220);

    // 2. EHLO
    await conn.send(`EHLO ${ehloName()}\r\n`);
    let ehlo = await conn.readReply();
    expectCode(ehlo, 250);

    // 3. STARTTLS upgrade if we're on a plaintext channel
    let channelEncrypted = config.secure;
    if (!config.secure) {
      const supportsStartTls = hasCapability(ehlo.capabilities, "STARTTLS");
      if (config.requireTLS && !supportsStartTls) {
        throw new SmtpError("Server does not advertise STARTTLS but requireTLS is set");
      }
      if (supportsStartTls) {
        await conn.send("STARTTLS\r\n");
        expectCode(await conn.readReply(), 220);
        await conn.upgradeToTls(config.host);
        channelEncrypted = true;
        // Re-EHLO over the encrypted channel — server capabilities may differ.
        await conn.send(`EHLO ${ehloName()}\r\n`);
        ehlo = await conn.readReply();
        expectCode(ehlo, 250);
      }
    }

    // 4. AUTH
    if (config.auth) {
      // Never transmit credentials on a plaintext socket (AUTH PLAIN/LOGIN are
      // base64, not encrypted). requireTLS only covers the port-587 config; a
      // custom port (25/2525) whose server advertises AUTH but not STARTTLS
      // would otherwise fall straight through to AUTH in the clear. The
      // localhost dev-relay carve-out opts out via allowPlaintextAuth.
      if (!channelEncrypted && !config.allowPlaintextAuth) {
        throw new SmtpError(
          "Refusing to send SMTP credentials over an unencrypted connection (server did not offer STARTTLS)",
        );
      }
      const mechs = authMechanisms(ehlo.capabilities);
      if (mechs.length === 0) {
        // Some servers advertise AUTH only after STARTTLS. We've already done that.
        // If still no AUTH, fail explicitly rather than send credentials in the clear.
        throw new SmtpError("Server does not advertise any AUTH mechanism");
      }
      const supportsPlain = mechs.includes("PLAIN");
      const supportsLogin = mechs.includes("LOGIN");
      if (supportsPlain) {
        const token = buildAuthPlainToken(config.auth.user, config.auth.pass);
        await conn.send(`AUTH PLAIN ${token}\r\n`);
        expectCode(await conn.readReply(), 235);
      } else if (supportsLogin) {
        await conn.send("AUTH LOGIN\r\n");
        expectCode(await conn.readReply(), 334);
        await conn.send(`${Buffer.from(config.auth.user, "utf8").toString("base64")}\r\n`);
        expectCode(await conn.readReply(), 334);
        await conn.send(`${Buffer.from(config.auth.pass, "utf8").toString("base64")}\r\n`);
        expectCode(await conn.readReply(), 235);
      } else {
        throw new SmtpError(`No supported AUTH mechanism (server offers: ${mechs.join(", ")})`);
      }
    }

    // 5. Envelope
    const fromAddr = extractAddrSpec(msg.from);
    const toAddr = extractAddrSpec(msg.to);
    await conn.send(`MAIL FROM:<${fromAddr}>\r\n`);
    expectCode(await conn.readReply(), 250);
    await conn.send(`RCPT TO:<${toAddr}>\r\n`);
    expectCode(await conn.readReply(), 250, 251);
    await conn.send("DATA\r\n");
    expectCode(await conn.readReply(), 354);

    // 6. Message
    const messageBytes = buildMessage(msg);
    await conn.send(messageBytes);
    // End-of-data marker. SMTP requires the body to be terminated with a line
    // containing only `.` — we make sure the body itself ends with CRLF first.
    await conn.send("\r\n.\r\n");
    expectCode(await conn.readReply(), 250);

    // 7. QUIT — best-effort; some servers close before we can read the reply.
    try {
      await conn.send("QUIT\r\n");
      await conn.readReply();
    } catch {
      // Ignore — message was already accepted.
    }
  } finally {
    conn.close();
  }
}

function buildMessage(msg: SmtpMessage): string {
  const fromDomain = extractDomain(msg.from);
  const messageId = `<${randomBytes(16).toString("hex")}@${fromDomain}>`;
  const subject = encodeSubject(msg.subject);
  const date = rfc5322Date();

  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
  ].join("\r\n");

  const body = dotStuff(encodeQuotedPrintable(msg.html));
  return `${headers}\r\n\r\n${body}`;
}

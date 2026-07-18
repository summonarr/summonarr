// Unit tests for the in-tree SMTP client (src/lib/smtp.ts) — the transport
// behind every notification email. The pure surfaces pinned here are the ones
// a mail server or spam filter judges us by: RFC 5322 header construction,
// RFC 2047 encoded-word subjects (also the header-injection backstop for
// non-ASCII/CRLF subjects), RFC 2045 quoted-printable encoding with 76-char
// soft wrapping that must never split an =XX escape, RFC 5321 dot-stuffing,
// envelope addr-spec extraction, and the SASL PLAIN/LOGIN credential encoding.
// The security contracts matter too: credentials must never be written to a
// channel whose EHLO advertised no AUTH, requireTLS must fail closed, and the
// DNS-rebind defense (TCP connects to the pre-resolved IP while TLS validates
// the ORIGINAL hostname via SNI) must hold on both TLS paths.
//
// None of the helpers are exported, so sendMail is driven through an
// in-memory fake transport: net.connect/tls.connect are swapped on the shared
// builtin module objects for the duration of each run. No OS socket is ever
// opened; every byte the client writes is captured for exact assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { EventEmitter } from "node:events";
import { sendMail, SmtpError, type SmtpConfig, type SmtpMessage } from "../src/lib/smtp.ts";

// EHLO uses the OS hostname when it looks FQDN-ish, else a fixed placeholder.
const EXPECTED_EHLO = os.hostname().includes(".") ? os.hostname() : "summonarr.local";

type Responder = (chunk: string) => string | null;

// Minimal duplex stand-in satisfying the surface SmtpConnection touches:
// on/off (from EventEmitter), write(data, "utf8", cb), end(), destroy().
class FakeSmtpSocket extends EventEmitter {
  readonly writes: string[] = [];
  wasDestroyed = false;
  greeted: boolean;
  readonly responder: Responder;
  readonly greeting: string | null;

  constructor(responder: Responder, greeting: string | null) {
    super();
    this.responder = responder;
    this.greeting = greeting;
    this.greeted = greeting === null; // null → upgraded channel, no banner
  }

  // SmtpConnection attaches its data listener in its constructor; emitting the
  // greeting on first attach guarantees the banner is never lost, without
  // depending on microtask-hop counts inside sendMail's awaits.
  on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(eventName, listener);
    if (eventName === "data" && !this.greeted && this.greeting !== null) {
      this.greeted = true;
      const banner = this.greeting;
      queueMicrotask(() => this.emit("data", Buffer.from(banner, "utf8")));
    }
    return this;
  }

  write(data: string, _enc: string, cb: (err?: Error) => void): boolean {
    this.writes.push(data);
    const reply = this.responder(data);
    if (reply !== null) {
      queueMicrotask(() => this.emit("data", Buffer.from(reply, "utf8")));
    }
    cb();
    return true;
  }

  end(): void {}
  destroy(): void {
    this.wasDestroyed = true;
  }
}

interface RunOptions {
  /** EHLO capability lines advertised before (or without) STARTTLS. */
  caps?: string[];
  /** EHLO capability lines advertised on the re-EHLO after STARTTLS. */
  capsAfterTls?: string[];
  greeting?: string;
  /** Per-verb canned reply overrides (verb → full reply incl. CRLF). */
  overrides?: Partial<Record<string, string>>;
  config?: Partial<SmtpConfig>;
  msg?: Partial<SmtpMessage>;
}

interface RunResult {
  error: unknown; // undefined on success
  writes: string[]; // every client write, chronological across sockets
  socketWrites: string[][]; // writes grouped per socket (plaintext vs post-TLS)
  netConnectOpts: Array<{ host: string; port: number }>;
  tlsConnectOpts: Array<{
    host: string | undefined;
    port: number | undefined;
    servername: string | undefined;
    wrapsExistingSocket: boolean;
  }>;
}

function makeResponder(opts: RunOptions): Responder {
  let inData = false;
  let authLoginStep = 0;
  let tlsStarted = false;
  return (chunk) => {
    if (inData) {
      if (chunk.endsWith("\r\n.\r\n")) {
        inData = false;
        return "250 2.0.0 message accepted\r\n";
      }
      return null; // message payload — no interim reply
    }
    if (authLoginStep === 1) {
      authLoginStep = 2;
      return "334 UGFzc3dvcmQ6\r\n";
    }
    if (authLoginStep === 2) {
      authLoginStep = 0;
      return "235 2.7.0 authentication successful\r\n";
    }
    const verb = chunk.replace(/\r\n$/, "").split(/[ :]/)[0].toUpperCase();
    const override = opts.overrides?.[verb];
    if (override) return override;
    switch (verb) {
      case "EHLO": {
        const caps = (tlsStarted ? (opts.capsAfterTls ?? opts.caps) : opts.caps) ?? [];
        const lines = ["fake.example.com greets you", ...caps];
        return (
          lines.map((l, i) => (i === lines.length - 1 ? `250 ${l}` : `250-${l}`)).join("\r\n") +
          "\r\n"
        );
      }
      case "STARTTLS":
        tlsStarted = true;
        return "220 2.0.0 ready to start TLS\r\n";
      case "AUTH":
        if (/^AUTH LOGIN/i.test(chunk)) {
          authLoginStep = 1;
          return "334 VXNlcm5hbWU6\r\n";
        }
        return "235 2.7.0 authentication successful\r\n";
      case "MAIL":
        return "250 2.1.0 sender ok\r\n";
      case "RCPT":
        return "250 2.1.5 recipient ok\r\n";
      case "DATA":
        inData = true;
        return "354 end data with <CRLF>.<CRLF>\r\n";
      case "QUIT":
        return "221 2.0.0 bye\r\n";
      default:
        return "250 ok\r\n";
    }
  };
}

const BASE_CONFIG: SmtpConfig = {
  host: "smtp.example.com",
  resolvedAddress: "192.0.2.10",
  port: 587,
  secure: false,
  requireTLS: false,
  // The fake-socket harness runs plaintext (no real TLS upgrade), so the AUTH
  // negotiation tests need the localhost-carve-out flag or sendMail would now
  // refuse to send credentials before mechanism selection is even reached.
  // The plaintext-refusal behavior itself is pinned by its own test below.
  allowPlaintextAuth: true,
};

const BASE_MSG: SmtpMessage = {
  from: '"Summonarr" <noreply@example.com>',
  to: "user@dest.example",
  subject: "Plain ASCII subject",
  html: "<p>Hello</p>",
};

async function runSendMail(opts: RunOptions = {}): Promise<RunResult> {
  const responder = makeResponder(opts);
  const greeting = opts.greeting ?? "220 fake.example.com ESMTP ready\r\n";
  const sockets: FakeSmtpSocket[] = [];
  const result: RunResult = {
    error: undefined,
    writes: [],
    socketWrites: [],
    netConnectOpts: [],
    tlsConnectOpts: [],
  };

  const fakeNetConnect = (options: net.TcpNetConnectOpts, cb?: () => void): net.Socket => {
    const s = new FakeSmtpSocket(responder, greeting);
    sockets.push(s);
    result.netConnectOpts.push({ host: String(options.host), port: Number(options.port) });
    if (cb) queueMicrotask(cb);
    return s as unknown as net.Socket;
  };

  const fakeTlsConnect = (options: tls.ConnectionOptions, cb?: () => void): tls.TLSSocket => {
    // STARTTLS upgrade wraps an existing socket (no banner on the new channel);
    // implicit TLS is a fresh connection and receives the greeting.
    const wraps = Boolean(options.socket);
    const s = new FakeSmtpSocket(responder, wraps ? null : greeting);
    sockets.push(s);
    result.tlsConnectOpts.push({
      host: typeof options.host === "string" ? options.host : undefined,
      port: typeof options.port === "number" ? options.port : undefined,
      servername: options.servername,
      wrapsExistingSocket: wraps,
    });
    if (cb) queueMicrotask(cb);
    return s as unknown as tls.TLSSocket;
  };

  const netMod = net as unknown as Record<"connect", unknown>;
  const tlsMod = tls as unknown as Record<"connect", unknown>;
  const realNetConnect = netMod.connect;
  const realTlsConnect = tlsMod.connect;
  netMod.connect = fakeNetConnect;
  tlsMod.connect = fakeTlsConnect;
  try {
    await sendMail({ ...BASE_CONFIG, ...opts.config }, { ...BASE_MSG, ...opts.msg });
  } catch (err) {
    result.error = err;
  } finally {
    netMod.connect = realNetConnect;
    tlsMod.connect = realTlsConnect;
  }
  result.socketWrites = sockets.map((s) => [...s.writes]);
  result.writes = sockets.flatMap((s) => s.writes);
  return result;
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

function extractMessage(writes: string[]): { headers: string[]; body: string; raw: string } {
  const dataIdx = writes.indexOf("DATA\r\n");
  assert.notEqual(dataIdx, -1, "client never sent DATA");
  const raw = writes[dataIdx + 1];
  const sep = raw.indexOf("\r\n\r\n");
  assert.notEqual(sep, -1, "message has no blank-line header/body separator");
  return { headers: raw.slice(0, sep).split("\r\n"), body: raw.slice(sep + 4), raw };
}

function header(headers: string[], name: string): string {
  const line = headers.find((h) => h.startsWith(`${name}: `));
  assert.ok(line, `missing header ${name}`);
  return line.slice(name.length + 2);
}

async function bodyFor(html: string): Promise<string> {
  const r = await runSendMail({ msg: { html } });
  assert.equal(r.error, undefined);
  return extractMessage(r.writes).body;
}

// Reference QP decoder (server's view): un-dot-stuff physical lines, remove
// soft breaks, then hex-decode. Written independently of the encoder.
function decodeQp(body: string): string {
  const unstuffed = body
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? l.slice(1) : l))
    .join("\r\n");
  const unwrapped = unstuffed.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < unwrapped.length; i++) {
    if (unwrapped[i] === "=") {
      bytes.push(parseInt(unwrapped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(unwrapped.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function asSmtpError(err: unknown): SmtpError {
  assert.ok(err instanceof SmtpError, `expected SmtpError, got: ${String(err)}`);
  return err;
}

// ─── Wire protocol / envelope ───────────────────────────────────────────────

test("happy path: exact command sequence, envelope strips display names", async () => {
  const r = await runSendMail({
    caps: ["AUTH PLAIN"],
    config: { auth: { user: "alice", pass: "s3cret" } },
    msg: { to: '"Some User" <user@dest.example>' },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.writes.length, 8);
  assert.equal(r.writes[0], `EHLO ${EXPECTED_EHLO}\r\n`);
  assert.match(r.writes[1], /^AUTH PLAIN [A-Za-z0-9+/]+=*\r\n$/);
  // MAIL FROM / RCPT TO carry the bare addr-spec, never the display-name form.
  assert.equal(r.writes[2], "MAIL FROM:<noreply@example.com>\r\n");
  assert.equal(r.writes[3], "RCPT TO:<user@dest.example>\r\n");
  assert.equal(r.writes[4], "DATA\r\n");
  assert.equal(r.writes[6], "\r\n.\r\n");
  assert.equal(r.writes[7], "QUIT\r\n");
});

test("message headers: fixed order, verbatim addresses, MIME declarations", async () => {
  const r = await runSendMail({ msg: { to: '"Some User" <user@dest.example>' } });
  assert.equal(r.error, undefined);
  const { headers } = extractMessage(r.writes);
  assert.deepEqual(
    headers.map((h) => h.slice(0, h.indexOf(":"))),
    ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"],
  );
  // Header From/To keep the display-name form the caller supplied.
  assert.equal(header(headers, "From"), '"Summonarr" <noreply@example.com>');
  assert.equal(header(headers, "To"), '"Some User" <user@dest.example>');
  assert.equal(header(headers, "MIME-Version"), "1.0");
  assert.equal(header(headers, "Content-Type"), "text/html; charset=utf-8");
  assert.equal(header(headers, "Content-Transfer-Encoding"), "quoted-printable");
  // RFC 5322 date with the numeric +0000 zone (GMT swapped out).
  assert.match(
    header(headers, "Date"),
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
  );
  // Message-ID: 16 random bytes hex @ sender domain — and unique per message.
  assert.match(header(headers, "Message-ID"), /^<[0-9a-f]{32}@example\.com>$/);
  const r2 = await runSendMail({});
  assert.notEqual(
    header(headers, "Message-ID"),
    header(extractMessage(r2.writes).headers, "Message-ID"),
  );
});

test("Message-ID domain falls back to summonarr.local for domainless senders", async () => {
  // No @ at all.
  const r1 = await runSendMail({ msg: { from: "bare-local-part" } });
  assert.equal(r1.error, undefined);
  assert.match(header(extractMessage(r1.writes).headers, "Message-ID"), /^<[0-9a-f]{32}@summonarr\.local>$/);
  assert.ok(r1.writes.includes("MAIL FROM:<bare-local-part>\r\n"));
  // @ present but empty domain.
  const r2 = await runSendMail({ msg: { from: '"N" <user@>' } });
  assert.equal(r2.error, undefined);
  assert.match(header(extractMessage(r2.writes).headers, "Message-ID"), /^<[0-9a-f]{32}@summonarr\.local>$/);
});

// ─── Subject encoding (RFC 2047) ────────────────────────────────────────────

test("ASCII subject passes through; unicode subject becomes a UTF-8 B encoded-word", async () => {
  const plain = await runSendMail({ msg: { subject: "Now Available: The Matrix (1999)" } });
  assert.equal(header(extractMessage(plain.writes).headers, "Subject"), "Now Available: The Matrix (1999)");

  const subject = "Résumé 📬 ready";
  const uni = await runSendMail({ msg: { subject } });
  const encoded = header(extractMessage(uni.writes).headers, "Subject");
  assert.equal(encoded, `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`);
  const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(encoded);
  assert.ok(m);
  assert.equal(Buffer.from(m[1], "base64").toString("utf8"), subject);
});

test("CRLF in the subject is neutralized by the encoded-word path (no header injection)", async () => {
  const subject = "Hello\r\nX-Injected: evil";
  const r = await runSendMail({ msg: { subject } });
  assert.equal(r.error, undefined);
  const { headers, raw } = extractMessage(r.writes);
  // CR/LF are outside printable ASCII, so the whole subject is base64-wrapped
  // into one physical header line — the injected header never materializes.
  assert.equal(raw.includes("X-Injected"), false);
  const encoded = header(headers, "Subject");
  const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(encoded);
  assert.ok(m);
  assert.equal(Buffer.from(m[1], "base64").toString("utf8"), subject);
  assert.equal(headers.some((h) => h.startsWith("X-Injected")), false);
});

// ─── Quoted-printable body (RFC 2045 §6.7) ──────────────────────────────────

test("QP: printable ASCII passes through verbatim, '=' is escaped as =3D", async () => {
  assert.equal(await bodyFor("if (a=b) { x < y & z; }"), "if (a=3Db) { x < y & z; }");
});

test("QP: UTF-8 multibyte sequences encode as uppercase =XX per byte", async () => {
  assert.equal(await bodyFor("café ✓"), "caf=C3=A9 =E2=9C=93");
});

test("QP: trailing whitespace before a break is encoded, interior whitespace kept", async () => {
  assert.equal(await bodyFor("dot \r\ntab\t\r\nmid dle"), "dot=20\r\ntab=09\r\nmid dle");
  // Trailing space at the very end of the body is also protected.
  assert.equal(await bodyFor("end "), "end=20");
});

test("QP: LF and CRLF both normalize to CRLF; a single trailing newline is dropped", async () => {
  assert.equal(await bodyFor("a\nb"), "a\r\nb");
  assert.equal(await bodyFor("a\r\nb"), "a\r\nb");
  assert.equal(await bodyFor("a\n\nb"), "a\r\n\r\nb"); // blank line preserved
  // Pins current behavior: the final CRLF is not re-emitted (sendMail's
  // "\r\n.\r\n" terminator supplies the closing line break on the wire).
  assert.equal(await bodyFor("a\r\n"), "a");
});

test("QP: soft wrap at 76 chars with '=' breaks, exact layout and boundaries", async () => {
  const body = await bodyFor("a".repeat(200));
  assert.equal(body, `${"a".repeat(75)}=\r\n${"a".repeat(75)}=\r\n${"a".repeat(50)}`);
  assert.ok(body.split("\r\n").every((l) => l.length <= 76));
  assert.equal(decodeQp(body), "a".repeat(200));
  // 76 chars fits on one line; 77 wraps.
  assert.equal(await bodyFor("a".repeat(76)), "a".repeat(76));
  assert.equal(await bodyFor("a".repeat(77)), `${"a".repeat(75)}=\r\naa`);
});

test("QP: a soft wrap never splits an =XX escape", async () => {
  // é lands its =C3=A9 straddling the wrap point at both back-up offsets.
  assert.equal(await bodyFor("a".repeat(74) + "é"), `${"a".repeat(74)}=\r\n=C3=A9`);
  assert.equal(await bodyFor("a".repeat(73) + "é"), `${"a".repeat(73)}=\r\n=C3=A9`);
  for (const n of [73, 74]) {
    assert.equal(decodeQp(await bodyFor("a".repeat(n) + "é")), "a".repeat(n) + "é");
  }
});

test("QP roundtrip: mixed unicode/equals/dots/long-line content decodes byte-identically", async () => {
  const nasty = `Ünïcödé <b>=tricky</b> ${"y".repeat(120)}\r\n.leading dot line\r\ntrailing space \r\nlast ✓`;
  const body = await bodyFor(nasty);
  assert.ok(body.split("\r\n").every((l) => l.length <= 76));
  assert.equal(decodeQp(body), nasty);
});

test("dot-stuffing doubles every leading dot; end-of-data marker is its own write", async () => {
  const r = await runSendMail({ msg: { html: ".starts\r\n..double\r\nsafe .mid\r\n." } });
  assert.equal(r.error, undefined);
  const { body } = extractMessage(r.writes);
  assert.equal(body, "..starts\r\n...double\r\nsafe .mid\r\n..");
  // Terminator is sent separately so the body can never be confused with it.
  const dataIdx = r.writes.indexOf("DATA\r\n");
  assert.equal(r.writes[dataIdx + 2], "\r\n.\r\n");
});

// ─── AUTH ───────────────────────────────────────────────────────────────────

test("AUTH PLAIN is preferred and sends base64(NUL user NUL pass), UTF-8 safe", async () => {
  const user = "alice";
  const pass = "s3cret!Ünï";
  const r = await runSendMail({
    caps: ["AUTH PLAIN LOGIN"],
    config: { auth: { user, pass } },
  });
  assert.equal(r.error, undefined);
  const authWrite = r.writes.find((w) => w.startsWith("AUTH "));
  assert.ok(authWrite);
  assert.equal(
    authWrite,
    `AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`, "utf8").toString("base64")}\r\n`,
  );
  assert.equal(r.writes.some((w) => w.startsWith("AUTH LOGIN")), false);
});

test("AUTH LOGIN fallback: base64 username and password as separate lines", async () => {
  const r = await runSendMail({
    caps: ["AUTH LOGIN"],
    config: { auth: { user: "bob", pass: "hunter2" } },
  });
  assert.equal(r.error, undefined);
  const loginIdx = r.writes.indexOf("AUTH LOGIN\r\n");
  assert.notEqual(loginIdx, -1);
  assert.equal(r.writes[loginIdx + 1], `${Buffer.from("bob", "utf8").toString("base64")}\r\n`);
  assert.equal(r.writes[loginIdx + 2], `${Buffer.from("hunter2", "utf8").toString("base64")}\r\n`);
});

test("AUTH capability parsing is case-insensitive", async () => {
  const r = await runSendMail({
    caps: ["auth plain"],
    config: { auth: { user: "alice", pass: "pw" } },
  });
  assert.equal(r.error, undefined);
  assert.ok(r.writes.some((w) => w.startsWith("AUTH PLAIN ")));
});

test("no AUTH advertised + auth configured → fail closed, credentials never sent", async () => {
  const r = await runSendMail({
    caps: [],
    config: { auth: { user: "alice", pass: "topsecret" } },
  });
  const err = asSmtpError(r.error);
  assert.equal(err.message, "Server does not advertise any AUTH mechanism");
  // Nothing credential-shaped and no envelope command ever hit the wire.
  assert.equal(r.writes.some((w) => w.startsWith("AUTH")), false);
  assert.equal(r.writes.some((w) => w.startsWith("MAIL FROM")), false);
  const b64pass = Buffer.from("topsecret", "utf8").toString("base64");
  assert.equal(r.writes.some((w) => w.includes(b64pass)), false);
});

test("no mutually supported mechanism → SmtpError listing the server's offer", async () => {
  const r = await runSendMail({
    caps: ["AUTH CRAM-MD5 XOAUTH2"],
    config: { auth: { user: "alice", pass: "pw" } },
  });
  const err = asSmtpError(r.error);
  assert.equal(err.message, "No supported AUTH mechanism (server offers: CRAM-MD5, XOAUTH2)");
  assert.equal(r.writes.some((w) => w.startsWith("AUTH")), false);
});

test("plaintext channel + AUTH advertised, no allowPlaintextAuth → refuse before credentials", async () => {
  // A non-587 port (25/2525) gets secure=false + requireTLS=false; a server
  // there that advertises AUTH but not STARTTLS must NOT receive the password
  // (AUTH PLAIN/LOGIN are base64, not encryption). The refusal fires before
  // mechanism selection so nothing credential-shaped ever hits the wire.
  const r = await runSendMail({
    caps: ["AUTH PLAIN LOGIN"],
    config: { auth: { user: "alice", pass: "topsecret" }, allowPlaintextAuth: false },
  });
  const err = asSmtpError(r.error);
  assert.equal(
    err.message,
    "Refusing to send SMTP credentials over an unencrypted connection (server did not offer STARTTLS)",
  );
  assert.equal(r.writes.some((w) => w.startsWith("AUTH")), false);
  assert.equal(r.writes.some((w) => w.startsWith("MAIL FROM")), false);
  const b64pass = Buffer.from("topsecret", "utf8").toString("base64");
  assert.equal(r.writes.some((w) => w.includes(b64pass)), false);
});

test("auth omitted from config → no AUTH command even when advertised", async () => {
  const r = await runSendMail({ caps: ["AUTH PLAIN LOGIN"] });
  assert.equal(r.error, undefined);
  assert.equal(r.writes.some((w) => w.startsWith("AUTH")), false);
});

// ─── TLS paths ──────────────────────────────────────────────────────────────

test("requireTLS with no STARTTLS advertised fails closed before any envelope command", async () => {
  const r = await runSendMail({
    caps: ["AUTH PLAIN"],
    config: { requireTLS: true, auth: { user: "alice", pass: "pw" } },
  });
  const err = asSmtpError(r.error);
  assert.equal(err.message, "Server does not advertise STARTTLS but requireTLS is set");
  assert.deepEqual(r.writes, [`EHLO ${EXPECTED_EHLO}\r\n`]);
});

test("STARTTLS: upgrade with SNI = original host, re-EHLO, credentials only post-TLS", async () => {
  const r = await runSendMail({
    caps: ["STARTTLS"],
    capsAfterTls: ["AUTH PLAIN"],
    // allowPlaintextAuth deliberately OFF: a genuine STARTTLS upgrade must
    // satisfy the encrypted-channel gate on its own.
    config: { requireTLS: true, auth: { user: "alice", pass: "pw" }, allowPlaintextAuth: false },
  });
  assert.equal(r.error, undefined);
  // TCP connect went to the pre-resolved IP; the TLS upgrade wrapped the
  // existing socket and pinned certificate validation to the ORIGINAL host.
  assert.deepEqual(r.netConnectOpts, [{ host: "192.0.2.10", port: 587 }]);
  assert.equal(r.tlsConnectOpts.length, 1);
  assert.deepEqual(r.tlsConnectOpts[0], {
    host: undefined,
    port: undefined,
    servername: "smtp.example.com",
    wrapsExistingSocket: true,
  });
  // Plaintext socket saw only EHLO + STARTTLS; everything else (including
  // AUTH) went over the upgraded channel, after a fresh EHLO.
  assert.equal(r.socketWrites.length, 2);
  assert.deepEqual(r.socketWrites[0], [`EHLO ${EXPECTED_EHLO}\r\n`, "STARTTLS\r\n"]);
  assert.equal(r.socketWrites[1][0], `EHLO ${EXPECTED_EHLO}\r\n`);
  assert.ok(r.socketWrites[1][1].startsWith("AUTH PLAIN "));
  assert.equal(r.socketWrites[0].some((w) => w.startsWith("AUTH")), false);
});

test("implicit TLS (secure): tls.connect targets the resolved IP with hostname SNI, no STARTTLS", async () => {
  const r = await runSendMail({
    caps: ["STARTTLS"], // advertised, but the wrap-mode client must ignore it
    config: { secure: true, port: 465 },
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.netConnectOpts, []);
  assert.deepEqual(r.tlsConnectOpts, [
    {
      host: "192.0.2.10",
      port: 465,
      servername: "smtp.example.com",
      wrapsExistingSocket: false,
    },
  ]);
  assert.equal(r.writes.includes("STARTTLS\r\n"), false);
});

// ─── Error surfacing ────────────────────────────────────────────────────────

test("server rejection → SmtpError with code and multi-line text joined by newline", async () => {
  const r = await runSendMail({
    overrides: { RCPT: "550-user unknown\r\n550 mailbox unavailable here\r\n" },
  });
  const err = asSmtpError(r.error);
  assert.equal(err.code, 550);
  assert.equal(err.name, "SmtpError");
  assert.equal(err.message, "SMTP server returned 550: user unknown\nmailbox unavailable here");
  // Failed before DATA — no message payload was written.
  assert.equal(r.writes.includes("DATA\r\n"), false);
});

test("rejecting greeting → SmtpError before the client writes anything", async () => {
  const r = await runSendMail({ greeting: "554 no service for you\r\n" });
  const err = asSmtpError(r.error);
  assert.equal(err.code, 554);
  assert.equal(err.message, "SMTP server returned 554: no service for you");
  assert.deepEqual(r.writes, []);
});

test("SmtpError shape: name, inheritance, optional code", () => {
  const bare = new SmtpError("boom");
  assert.equal(bare.name, "SmtpError");
  assert.ok(bare instanceof Error);
  assert.equal(bare.code, undefined);
  assert.equal(new SmtpError("slow down", 421).code, 421);
});

// ─── CRLF injection defense (From/To) ───────────────────────────────────────

test("CRLF in From/To is stripped before the header lines AND the envelope (injection defense)", async () => {
  // A raw CRLF in either address would otherwise split the From:/To: header
  // line into an attacker-chosen extra header, and ride extractAddrSpec into
  // MAIL FROM/RCPT TO as an injected SMTP command. email.ts already strips
  // newlines caller-side (safeHeader); this pins the smtp.ts-layer defense so
  // a future caller can't reintroduce the hole.
  const r = await runSendMail({
    msg: {
      from: '"Evil" <evil@example.com>\r\nBcc: hidden@dest.example',
      to: "user@dest.example\r\nX-Injected: yes",
    },
  });
  assert.equal(r.error, undefined);

  // Envelope: exactly one MAIL FROM and one RCPT TO, each a single command
  // carrying the newline-stripped value — no second command smuggled in.
  assert.deepEqual(
    r.writes.filter((w) => w.startsWith("MAIL FROM:")),
    ["MAIL FROM:<evil@example.com>\r\n"], // addr-spec from the FIRST <> pair of the stripped value
  );
  assert.deepEqual(
    r.writes.filter((w) => w.startsWith("RCPT TO:")),
    ["RCPT TO:<user@dest.exampleX-Injected: yes>\r\n"], // mangled-but-single command, server rejects at worst
  );

  // Headers: the payload stays inside one From:/To: line; no Bcc:/X-Injected:
  // header line exists anywhere in the message.
  const { headers } = extractMessage(r.writes);
  assert.equal(header(headers, "From"), '"Evil" <evil@example.com>Bcc: hidden@dest.example');
  assert.equal(header(headers, "To"), "user@dest.exampleX-Injected: yes");
  assert.equal(headers.some((h) => h.startsWith("Bcc:")), false);
  assert.equal(headers.some((h) => h.startsWith("X-Injected:")), false);
});

test("NUL bytes in From/To are stripped alongside CR/LF", async () => {
  const r = await runSendMail({ msg: { from: "no\0reply@example.com", to: "user\0@dest.example" } });
  assert.equal(r.error, undefined);
  const { headers } = extractMessage(r.writes);
  assert.equal(header(headers, "From"), "noreply@example.com");
  assert.equal(header(headers, "To"), "user@dest.example");
  assert.equal(r.writes.includes("RCPT TO:<user@dest.example>\r\n"), true);
});

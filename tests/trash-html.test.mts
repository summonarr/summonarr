// Unit tests for stripTrashHtml (src/lib/trash-html.ts) — the sanitizer that
// turns upstream TRaSH-Guides `trash_description` HTML into plain prose for
// React text rendering. The security contract is one-way stripping: output is
// rendered as escaped text (never dangerouslySetInnerHTML), so the properties
// that matter are (1) all tags removed — including adversarial reassembly
// nesting, which is why the strip loops until stable — (2) `&amp;` decoded
// LAST so `&amp;lt;` can never double-unescape into a live `<`, and
// (3) formatting the UI relies on is preserved: <br> → newline, anchor text
// kept with the href dropped, whitespace collapsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTrashHtml } from "../src/lib/trash-html.ts";

test("plain text passes through untouched", () => {
  assert.equal(stripTrashHtml("Optimized for quality releases."), "Optimized for quality releases.");
  assert.equal(stripTrashHtml(""), "");
});

test("<br> variants become newlines (case-insensitive, self-closing, spaced)", () => {
  assert.equal(stripTrashHtml("a<br>b<BR>c<br/>d<br />e<Br  />f"), "a\nb\nc\nd\ne\nf");
});

test("anchors keep their text and drop the href", () => {
  assert.equal(
    stripTrashHtml('See <a href="https://discord.gg/trash">the TRaSH Discord</a> for help'),
    "See the TRaSH Discord for help",
  );
  // Global + case-insensitive: multiple anchors in one string, any casing.
  assert.equal(
    stripTrashHtml('<A HREF="u1">One</A> and <a class="x" href="u2">Two</a>'),
    "One and Two",
  );
});

test("anchor content spanning newlines is kept ([\\s\\S] matching)", () => {
  assert.equal(stripTrashHtml('<a href="u">line one\nline two</a>'), "line one\nline two");
});

test("tags nested inside an anchor are unwrapped then stripped", () => {
  assert.equal(stripTrashHtml('<a href="x"><code>WEB-DL</code></a>'), "WEB-DL");
});

test("an unterminated anchor falls through to the generic tag strip", () => {
  // No </a>, so the anchor unwrap doesn't match — the tag-strip loop removes
  // the opening tag and the text survives.
  assert.equal(stripTrashHtml('See <a href="https://x">the docs'), "See the docs");
});

test("formatting tags are stripped, their text kept", () => {
  assert.equal(
    stripTrashHtml("<strong>Bold</strong> and <em>italic</em> and <code>x265</code>"),
    "Bold and italic and x265",
  );
});

test("dangerous tags are removed entirely; text content is kept as inert prose", () => {
  // Attribute-borne payloads vanish with the tag.
  assert.equal(stripTrashHtml('<img src=x onerror=alert(1)>'), "");
  assert.equal(stripTrashHtml('<svg onload=alert(1)></svg>'), "");
  assert.equal(stripTrashHtml('<iframe src="javascript:alert(1)"></iframe>'), "");
  // Element CONTENT survives as plain text — current (safe) behavior, because
  // the output is React-text-rendered, never injected as HTML.
  assert.equal(
    stripTrashHtml("<script>alert(document.cookie)</script>"),
    "alert(document.cookie)",
  );
});

test("adversarial nested markup cannot reassemble into a tag (loop-until-stable)", () => {
  // The CodeQL single-pass hazard: removing the inner <script> must not leave
  // a re-formed executable tag behind. Exact current output pinned.
  assert.equal(stripTrashHtml("<scr<script>ipt>alert(1)</script>"), "ipt>alert(1)");
  assert.ok(!stripTrashHtml("<scr<script>ipt>alert(1)</script>").includes("<script"));
  assert.equal(stripTrashHtml("<<script>script>alert(1)<</script>/script>"), "script>alert(1)/script>");
  assert.ok(!stripTrashHtml("<<script>script>alert(1)<</script>/script>").includes("<script>"));
});

test("HTML entities decode to their literal characters", () => {
  assert.equal(
    stripTrashHtml("&lt;b&gt; &quot;quoted&quot; &#39;single&#39; A &amp; B"),
    "<b> \"quoted\" 'single' A & B",
  );
});

test("&amp; decodes LAST — &amp;lt; can never double-unescape into a live <", () => {
  // If &amp; were decoded first, "&amp;lt;script&amp;gt;" would collapse to
  // "<script>" via a second-pass &lt; match. Pin the safe ordering.
  assert.equal(stripTrashHtml("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(stripTrashHtml("&amp;amp;"), "&amp;");
});

test("only the five listed entities decode — other numeric entities stay literal", () => {
  // Current behavior pinned: &#60;/&#62; are NOT in the decode table, so they
  // remain inert text and cannot smuggle angle brackets past the strip.
  assert.equal(stripTrashHtml("&#60;script&#62;"), "&#60;script&#62;");
});

test("whitespace collapses: runs of spaces/tabs to one space, trimmed around newlines and ends", () => {
  assert.equal(stripTrashHtml("  Multiple   spaces\t\tand  tabs  "), "Multiple spaces and tabs");
  // Space/tab runs touching a newline are removed on both sides.
  assert.equal(stripTrashHtml("line1   \n\t  line2"), "line1\nline2");
  // Consecutive newlines (paragraph breaks from <br><br>) are preserved.
  assert.equal(stripTrashHtml("a<br><br>b"), "a\nb".replace("\n", "\n\n"));
  // Leading/trailing <br> newlines are trimmed off.
  assert.equal(stripTrashHtml("<br>text<br>"), "text");
});

test("realistic TRaSH description shapes into prose", () => {
  const input =
    'Optimized for quality.<br><br>Ask in <a href="https://discord.gg/trash">the TRaSH Discord</a> &amp; read the docs.';
  assert.equal(
    stripTrashHtml(input),
    "Optimized for quality.\n\nAsk in the TRaSH Discord & read the docs.",
  );
});

test("degenerate angle brackets never throw and pass through as text", () => {
  // "<>" has no [^>]+ body so it is not a tag; a lone "<" with no ">" after it
  // can never match. Both are inert in React text rendering.
  assert.equal(stripTrashHtml("a <> b"), "a <> b");
  assert.equal(stripTrashHtml("ends with a dangling <"), "ends with a dangling <");
});

test("prose spanning < … > is eaten as a tag — strip is deliberately lossy (pinned)", () => {
  // "< 1080p and bitrate >" matches <[^>]+> and vanishes. By design: the
  // sanitizer fails CLOSED (over-strips) rather than open. Real HTML payloads
  // encode a literal less-than as &lt;, which decodes fine (next tests).
  assert.equal(stripTrashHtml("resolution < 1080p and bitrate > 8000"), "resolution 8000");
  assert.equal(stripTrashHtml("resolution &lt; 1080p and bitrate &gt; 8000"), "resolution < 1080p and bitrate > 8000");
});

test("a > inside an attribute value ends the tag early (regex-sanitizer boundary, pinned)", () => {
  // Regex tag matching stops at the first ">" even inside a quoted attribute.
  // The leaked remainder is plain text — ugly but inert, and pinned so an
  // "improvement" here gets a deliberate review.
  assert.equal(stripTrashHtml('<a href="x>y">link</a>'), 'y">link');
});

// The profile, two-factor, push, Discord and notification operations document
// their response bodies as schemas, field for field what the handlers send.
// Several carry one-time secrets (TOTP secret, recovery codes, WebAuthn
// challenge and registration tokens, QuickConnect secret/flowState): those pins
// also hold the formats to the code that mints them and keep the spec from
// promising a field the handler never sends.

import {
  getSpec, responseSchema, keysOf, handlerSource, interfaceFields, libSource, jsonBodyKeys,
  type SchemaNode,
} from "./_openapi-spec.mts";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { RECOVERY_CODE_COUNT, generateRecoveryCodes } from "../src/lib/mfa/recovery-codes.ts";
import { generateTotpSecret, buildOtpauthUri } from "../src/lib/mfa/totp.ts";
import { SUPPORTED_COSE_ALGS } from "../src/lib/mfa/webauthn.ts";

/** The key sets of a handler's success answers (object literals without `error`). */
function successAnswers(path: string, method: string): string[][] {
  const sets = jsonBodyKeys(handlerSource(path, method)).filter((k) => !k.includes("error"));
  assert.ok(sets.length > 0, `${method.toUpperCase()} ${path}: no success answer found`);
  return sets;
}
const sorted = (xs: Iterable<string>) => [...xs].sort();
const union = (sets: string[][]) => sorted(new Set(sets.flat()));
const intersection = (sets: string[][]) => sorted(sets[0].filter((k) => sets.every((s) => s.includes(k))));

/** The keys of the object literal `<prop>: { … }` (or `<prop>: x.map((p) => ({ … }))`) first found in `src`. */
function nestedKeys(src: string, prop: string): string[] {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: string[] | null = null;
  const literalOf = (e: ts.Expression): ts.ObjectLiteralExpression | null => {
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isParenthesizedExpression(e)) return literalOf(e.expression);
    if (ts.isCallExpression(e) && e.arguments[0] && ts.isArrowFunction(e.arguments[0]) && !ts.isBlock(e.arguments[0].body)) {
      return literalOf(e.arguments[0].body);
    }
    return null;
  };
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === prop) {
      const obj = literalOf(n.initializer);
      if (obj) {
        found = sorted(obj.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : p.getText(sf))));
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(found, `${prop}: { … } not found`);
  return found;
}

const OK_TRUE_OPS: Array<[string, string]> = [
  ["/sessions", "delete"],
  ["/profile/mfa", "delete"],
  ["/profile/mfa/totp", "delete"],
  ["/profile/mfa/passkeys/{id}", "patch"],
  ["/profile/mfa/passkeys/{id}", "delete"],
  ["/profile/notifications", "patch"],
  ["/profile/trakt", "delete"],
  ["/push/subscribe", "post"],
  ["/push/subscribe", "delete"],
  ["/auth/sign-out", "post"],
  ["/profile/calendar", "delete"],
  ["/profile", "delete"],
  ["/discord/initiate-merge", "post"],
  ["/watchlist", "delete"],
  ["/hidden", "delete"],
  ["/discord/unlink", "post"],
  ["/push/apns", "post"],
  ["/push/apns", "delete"],
];

test("the plain acknowledgements document { ok: true }, and their handlers send exactly that", async () => {
  for (const [path, method] of OK_TRUE_OPS) {
    const where = `${method.toUpperCase()} ${path}`;
    const schema = await responseSchema(path, method, "200");
    assert.deepEqual(keysOf(schema), ["ok"], where);
    assert.deepEqual(schema.required, ["ok"], where);
    assert.deepEqual(schema.properties?.ok.enum, [true], where);
    for (const keys of successAnswers(path, method)) assert.deepEqual(keys, ["ok"], where);
    assert.doesNotMatch(handlerSource(path, method), /ok: false/, where);
  }
});

test("small profile answers document every key their handlers send, and only the always-present ones as required", async () => {
  const ops: Array<[string, string]> = [
    ["/profile/password", "patch"],
    ["/profile/mfa", "get"],
    ["/discord/confirm-merge", "post"],
    ["/discord/sync-roles", "post"],
    ["/discord/register-commands", "post"],
    ["/discord/status", "get"],
    ["/notifications", "post"],
    ["/notifications", "delete"],
  ];
  for (const [path, method] of ops) {
    const where = `${method.toUpperCase()} ${path}`;
    const schema = await responseSchema(path, method, "200");
    const answers = successAnswers(path, method);
    assert.deepEqual(keysOf(schema), union(answers), where);
    assert.deepEqual(sorted(schema.required ?? []), intersection(answers), where);
  }
  // The role sync's "nothing to do" answer is { synced: 0 } alone.
  assert.deepEqual((await responseSchema("/discord/sync-roles", "post", "200")).required, ["synced"]);
  // A password change revokes every session, this one included.
  assert.deepEqual((await responseSchema("/profile/password", "patch", "200")).properties?.requiresRelogin.enum, [true]);
  assert.match(handlerSource("/profile/password", "patch"), /NextResponse\.json\(\{ ok: true, requiresRelogin: true \}\)/);
});

test("the two-factor status lists each passkey by name and dates only — never its credential or key", async () => {
  const schema = await responseSchema("/profile/mfa", "get", "200");
  const item = schema.properties?.passkeys.items;
  const sent = nestedKeys(handlerSource("/profile/mfa", "get"), "passkeys");
  assert.deepEqual(keysOf(item), sent);
  assert.deepEqual(sorted(item?.required ?? []), sent);
  for (const secret of ["credentialId", "publicKey", "signCount"]) {
    assert.ok(!sent.includes(secret), `the handler sends ${secret}`);
    assert.ok(!keysOf(item).includes(secret), `the spec documents ${secret}`);
  }
});

test("TOTP setup documents the secret and otpauth URI in the formats the code mints", async () => {
  const schema = await responseSchema("/profile/mfa/totp/setup", "post", "200");
  const sent = successAnswers("/profile/mfa/totp/setup", "post");
  assert.deepEqual(sent, [["otpauthUri", "secret"]]);
  assert.deepEqual(keysOf(schema), sent[0]);
  assert.deepEqual(sorted(schema.required ?? []), sent[0]);
  const secret = generateTotpSecret();
  assert.match(secret, new RegExp(schema.properties?.secret.pattern ?? "^$"));
  assert.match(
    buildOtpauthUri({ secret, accountName: "someone@example.com" }),
    new RegExp(schema.properties?.otpauthUri.pattern ?? "^$"),
  );
});

test("recovery codes are documented as the count and format the code mints, and only with the first factor", async () => {
  const fresh = await responseSchema("/profile/mfa/recovery-codes", "post", "200");
  assert.deepEqual(successAnswers("/profile/mfa/recovery-codes", "post"), [["recoveryCodes"]]);
  assert.deepEqual(keysOf(fresh), ["recoveryCodes"]);
  const codes = fresh.properties?.recoveryCodes as SchemaNode & { minItems?: number };
  assert.equal(codes.minItems, RECOVERY_CODE_COUNT);
  assert.equal(codes.maxItems, RECOVERY_CODE_COUNT);
  const pattern = new RegExp(codes.items?.pattern ?? "^$");
  const minted = generateRecoveryCodes();
  assert.equal(minted.length, RECOVERY_CODE_COUNT);
  for (const code of minted) assert.match(code, pattern);

  // TOTP enable and passkey add answer { ok: true } plus the codes only when
  // they minted them (the account's first factor) — so `recoveryCodes` is optional.
  const spreads: Record<string, RegExp> = {
    "/profile/mfa/totp/enable": /^\.\.\.\(outcome\.recoveryCodes \? \{ recoveryCodes: outcome\.recoveryCodes \} : \{\}\)$/,
    "/profile/mfa/passkeys": /^\.\.\.\(recoveryCodes \? \{ recoveryCodes \} : \{\}\)$/,
  };
  for (const [path, spread] of Object.entries(spreads)) {
    const schema = await responseSchema(path, "post", "200");
    const [answer, ...rest] = successAnswers(path, "post");
    assert.equal(rest.length, 0, path);
    assert.equal(answer.length, 2, path);
    assert.match(answer[0], spread, path);
    assert.equal(answer[1], "ok", path);
    assert.deepEqual(keysOf(schema), ["ok", "recoveryCodes"], path);
    assert.deepEqual(schema.required, ["ok"], path);
    assert.deepEqual(schema.properties?.recoveryCodes.items, codes.items, path);
  }
});

test("the WebAuthn challenge and registration options document exactly the keys the handlers send", async () => {
  const challenge = await responseSchema("/profile/mfa/challenge", "post", "200");
  const challengeSrc = handlerSource("/profile/mfa/challenge", "post");
  assert.deepEqual(successAnswers("/profile/mfa/challenge", "post"), [["challengeToken", "publicKey"]]);
  assert.deepEqual(keysOf(challenge), ["challengeToken", "publicKey"]);
  assert.deepEqual(keysOf(challenge.properties?.publicKey), nestedKeys(challengeSrc, "publicKey"));
  assert.deepEqual(keysOf(challenge.properties?.publicKey.properties?.allowCredentials.items), nestedKeys(challengeSrc, "allowCredentials"));

  const options = await responseSchema("/profile/mfa/passkeys/options", "post", "200");
  const optionsSrc = handlerSource("/profile/mfa/passkeys/options", "post");
  assert.deepEqual(successAnswers("/profile/mfa/passkeys/options", "post"), [["publicKey", "registrationToken"]]);
  assert.deepEqual(keysOf(options), ["publicKey", "registrationToken"]);
  const pk = options.properties?.publicKey;
  assert.deepEqual(keysOf(pk), nestedKeys(optionsSrc, "publicKey"));
  for (const k of ["rp", "user", "authenticatorSelection", "excludeCredentials", "pubKeyCredParams"]) {
    const node = pk?.properties?.[k];
    assert.deepEqual(keysOf(node?.items ?? node), nestedKeys(optionsSrc, k), k);
  }
  assert.deepEqual(pk?.properties?.pubKeyCredParams.items?.properties?.alg.enum, [...SUPPORTED_COSE_ALGS]);
  // The user handle is a hash of the account id, never the email.
  assert.match(optionsSrc, /user: \{ id: webAuthnUserHandle\(user\.id\),/);
  assert.match(libSource("mfa/mfa-store.ts"), /export function webAuthnUserHandle\(userId: string\): string \{\n\s+return createHash\("sha256"\)/);
});

test("QuickConnect initiation documents the code and secret, and flowState only for a native caller", async () => {
  const schema = await responseSchema("/auth/jellyfin/quickconnect", "post", "200");
  const result = interfaceFields(libSource("jellyfin.ts"), "JellyfinQuickConnectResult");
  assert.deepEqual(result, ["code", "secret"]);
  assert.deepEqual(keysOf(schema), sorted([...result, "flowState"]));
  assert.deepEqual(sorted(schema.required ?? []), result);
  const src = handlerSource("/auth/jellyfin/quickconnect", "post");
  assert.match(src, /NextResponse\.json\(isNative \? \{ \.\.\.result, flowState: cookieValue \} : result\)/);
  assert.match(schema.properties?.flowState.description ?? "", /X-Summonarr-Client/);
});

test("PATCH /profile/trakt answers the GET's connection state, field for field TraktProfileState", async () => {
  const get = await responseSchema("/profile/trakt", "get", "200");
  const patch = await responseSchema("/profile/trakt", "patch", "200");
  assert.deepEqual(patch, get);
  assert.deepEqual(keysOf(get), interfaceFields(libSource("trakt-user.ts"), "TraktProfileState"));
  assert.match(handlerSource("/profile/trakt", "patch"), /return NextResponse\.json\(await getTraktProfileState\(userId, session\.user\.permissions\)\);/);
  assert.match(handlerSource("/profile/trakt", "get"), /NextResponse\.json\(await getTraktProfileState\(/);
});

test("every profile-group 2xx documents a JSON schema", async () => {
  const spec = await getSpec();
  const paths = Object.keys(spec.paths).filter((p) =>
    /^\/(profile|push|discord|notifications|sessions)(\/|$)/.test(p) || p === "/auth/sign-out" || p === "/auth/jellyfin/quickconnect");
  assert.ok(paths.length >= 20, `only ${paths.length} paths`);
  for (const path of paths) {
    for (const [method, op] of Object.entries(spec.paths[path])) {
      for (const [status, res] of Object.entries(op.responses)) {
        if (!status.startsWith("2") || status === "204") continue;
        const media = Object.keys(res.content ?? {});
        assert.ok(media.length > 0, `${method.toUpperCase()} ${path} ${status} documents no body`);
        const schema = res.content?.["application/json"]?.schema;
        if (schema?.type === "object") {
          assert.ok(schema.properties || schema.additionalProperties || schema.description, `${method.toUpperCase()} ${path} ${status} is a bare object`);
        }
      }
    }
  }
});

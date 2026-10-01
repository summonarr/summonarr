// Browser half of the WebAuthn second factor: turns the server's JSON options
// (binary fields as base64url) into the ArrayBuffers navigator.credentials
// wants, and the resulting PublicKeyCredential back into base64url JSON for
// POST. The server (src/lib/mfa/webauthn.ts) does every security check; this
// file only converts shapes. Zero imports, safe for any "use client" module.

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isWebAuthnSupported(): boolean {
  return typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function";
}

interface CredentialDescriptorJSON {
  type: "public-key";
  id: string;
  transports?: string[];
}

export interface CreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: CredentialDescriptorJSON[];
}

export interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  allowCredentials: CredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
  timeout?: number;
}

function descriptor(d: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    type: "public-key",
    id: base64UrlToBuffer(d.id),
    ...(d.transports && d.transports.length > 0 ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  };
}

// navigator.credentials.create → registration JSON for POST /api/profile/mfa/passkeys.
export async function createPasskey(options: CreationOptionsJSON): Promise<Record<string, unknown>> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: options.rp,
      user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
      challenge: base64UrlToBuffer(options.challenge),
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation ?? "none",
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: (options.excludeCredentials ?? []).map(descriptor),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const response = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: bufferToBase64Url(cred.rawId),
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports,
    },
  };
}

// navigator.credentials.get → assertion JSON for POST /api/auth/sign-in/mfa.
export async function getPasskeyAssertion(options: RequestOptionsJSON): Promise<Record<string, unknown>> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: base64UrlToBuffer(options.challenge),
      rpId: options.rpId,
      allowCredentials: options.allowCredentials.map(descriptor),
      userVerification: options.userVerification ?? "preferred",
      timeout: options.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was used.");
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: bufferToBase64Url(cred.rawId),
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
  };
}

// A cancelled/timed-out browser prompt is not an error worth a red message.
export function isWebAuthnCancel(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
}

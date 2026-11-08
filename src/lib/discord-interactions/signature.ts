import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { processSingleton } from "@/lib/process-singleton";

// No TTL: the key is read once and kept until /api/settings or a database
// restore drops it. Process-wide (guardrail 27a): those callers live in other
// chunks, and a per-chunk copy would let the interactions route keep verifying
// against a key the database no longer holds. `gen` stops a read that was in
// flight across an invalidation from caching the old key.
const keyState = processSingleton("discord-interactions:publicKey", () => ({
  key: null as string | null,
  gen: 0,
}));

export function invalidatePublicKeyCache() {
  keyState.gen++;
  keyState.key = null;
}

export async function prewarmPublicKeyCache(): Promise<void> {
  await getPublicKey();
}

export async function getPublicKey(): Promise<string | null> {
  if (keyState.key) return keyState.key;
  const gen = keyState.gen;
  const pkRow = await prisma.setting.findUnique({ where: { key: "discordPublicKey" } });
  const key = pkRow?.value || null;
  if (key && gen === keyState.gen) keyState.key = key;
  return key;
}

export function verifySignature(publicKeyHex: string, signature: string, timestamp: string, body: string): boolean {
  try {
    // Discord sends Ed25519 raw keys; wrap with SPKI DER header so Node's crypto can parse it
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    const derKey = Buffer.concat([prefix, Buffer.from(publicKeyHex, "hex")]);
    const key = createPublicKey({ key: derKey, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

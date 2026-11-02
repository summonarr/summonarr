import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma } from "@/lib/prisma";

let cachedPublicKey: string | null = null;

export function invalidatePublicKeyCache() {
  cachedPublicKey = null;
}

export async function prewarmPublicKeyCache(): Promise<void> {
  await getPublicKey();
}

export async function getPublicKey(): Promise<string | null> {
  if (cachedPublicKey) return cachedPublicKey;
  const pkRow = await prisma.setting.findUnique({ where: { key: "discordPublicKey" } });
  if (pkRow?.value) cachedPublicKey = pkRow.value;
  return cachedPublicKey ?? null;
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

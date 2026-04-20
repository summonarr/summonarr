import { NextResponse } from "next/server";
import { getOrCreateVapidPublicKey } from "@/lib/push";

export async function GET() {
  const publicKey = await getOrCreateVapidPublicKey();
  return NextResponse.json({ publicKey });
}

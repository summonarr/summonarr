import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    notifyOnApproved?: boolean; notifyOnAvailable?: boolean; notifyOnDeclined?: boolean;
    emailOnApproved?: boolean;  emailOnAvailable?: boolean;  emailOnDeclined?: boolean;
    pushOnApproved?: boolean;   pushOnAvailable?: boolean;   pushOnDeclined?: boolean;
    notifyOnIssue?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Record<string, boolean> = {};
  if (typeof body.notifyOnApproved === "boolean") data.notifyOnApproved = body.notifyOnApproved;
  if (typeof body.notifyOnAvailable === "boolean") data.notifyOnAvailable = body.notifyOnAvailable;
  if (typeof body.notifyOnDeclined === "boolean") data.notifyOnDeclined = body.notifyOnDeclined;
  if (typeof body.emailOnApproved === "boolean")  data.emailOnApproved  = body.emailOnApproved;
  if (typeof body.emailOnAvailable === "boolean") data.emailOnAvailable = body.emailOnAvailable;
  if (typeof body.emailOnDeclined === "boolean")  data.emailOnDeclined  = body.emailOnDeclined;
  if (typeof body.pushOnApproved === "boolean")   data.pushOnApproved   = body.pushOnApproved;
  if (typeof body.pushOnAvailable === "boolean")  data.pushOnAvailable  = body.pushOnAvailable;
  if (typeof body.pushOnDeclined === "boolean")   data.pushOnDeclined   = body.pushOnDeclined;
  if (typeof body.notifyOnIssue === "boolean")    data.notifyOnIssue    = body.notifyOnIssue;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  await prisma.user.update({ where: { id: session.user.id }, data });
  return NextResponse.json({ ok: true });
}

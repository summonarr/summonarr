import { NextResponse } from "next/server";
import { auth } from "./auth";
import { prisma } from "./prisma";

export async function getMaintenanceStatus(): Promise<{ enabled: boolean; message: string }> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["maintenanceEnabled", "maintenanceMessage"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      enabled: cfg.maintenanceEnabled === "true",
      message: cfg.maintenanceMessage ?? "",
    };
  } catch {
    return { enabled: false, message: "" };
  }
}

export async function maintenanceGuard(): Promise<NextResponse | null> {
  // Read role from session inside the guard rather than trusting a caller-supplied value.
  // NextAuth resolves the session from cookies/JWT without a DB hit, so the cost is negligible
  // even when the caller has already invoked auth() for its own purposes.
  const session = await auth();
  if (session?.user?.role === "ADMIN") return null;
  const { enabled, message } = await getMaintenanceStatus();
  if (!enabled) return null;
  return NextResponse.json(
    { error: "Service unavailable", message: message || "Under maintenance" },
    { status: 503 }
  );
}

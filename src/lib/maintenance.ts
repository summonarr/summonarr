import { NextResponse } from "next/server";
import { authActive } from "./auth";
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
    // A Settings read failure means we cannot prove maintenance is off; fail closed
    // so writes don't slip through during a database incident.
    return { enabled: true, message: "" };
  }
}

export async function maintenanceGuard(): Promise<NextResponse | null> {
  // DB-checked session (authActive, not JWT-only auth) so a demoted admin holding an
  // unexpired JWT can't bypass maintenance: the admin-bypass is an authz decision and
  // must see the current role, not a stale one.
  const session = await authActive();
  if (session?.user?.role === "ADMIN") return null;
  const { enabled, message } = await getMaintenanceStatus();
  if (!enabled) return null;
  return NextResponse.json(
    { error: "Service unavailable", message: message || "Under maintenance" },
    { status: 503 }
  );
}


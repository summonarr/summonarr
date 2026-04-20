import { NextResponse } from "next/server";
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

export async function maintenanceGuard(userRole?: string): Promise<NextResponse | null> {
  if (userRole === "ADMIN") return null;
  const { enabled, message } = await getMaintenanceStatus();
  if (!enabled) return null;
  return NextResponse.json(
    { error: "Service unavailable", message: message || "Under maintenance" },
    { status: 503 }
  );
}

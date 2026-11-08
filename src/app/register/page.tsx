import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Public self-registration is disabled; route always redirects to /setup (empty DB) or /login
export default async function RegisterPage() {
  const anyUser = await prisma.user.findFirst({ select: { id: true } });
  if (!anyUser) redirect("/setup");
  redirect("/login");
}

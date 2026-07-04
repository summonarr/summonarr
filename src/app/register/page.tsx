import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Public self-registration is disabled; route always redirects to /setup (empty DB) or /login
export default async function RegisterPage() {
  const count = await prisma.user.count();
  if (count === 0) redirect("/setup");
  redirect("/login");
}

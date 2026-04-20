import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
import { SetupForm } from "@/app/setup/setup-form";
import { Film } from "lucide-react";

// Public self-registration is disabled; route always redirects to /setup (empty DB) or /login
export default async function RegisterPage() {
  const count = await prisma.user.count();
  if (count === 0) redirect("/setup");
  redirect("/login");

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-xl p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center mb-3">
            <Film className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">Create an account</h1>
          <p className="text-zinc-400 text-sm mt-1">Request movies and TV shows</p>
        </div>

        <SetupForm variant="register" />

        <p className="text-center text-xs text-zinc-500 mt-6">
          Already have an account?{" "}
          <a href="/login" className="text-indigo-400 hover:text-indigo-300">
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}

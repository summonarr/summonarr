import { Wrench } from "lucide-react";

export function MaintenancePage({ message }: { message?: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-950">
      <div className="text-center max-w-md px-6">
        <div className="w-16 h-16 rounded-full bg-yellow-900/30 border border-yellow-800/30 flex items-center justify-center mx-auto mb-6">
          <Wrench className="w-8 h-8 text-yellow-400" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-3">Under Maintenance</h1>
        <p className="text-zinc-400 mb-6">
          {message || "We're performing some maintenance. Please check back shortly."}
        </p>
        <a
          href="/"
          className="inline-block px-4 py-2 text-sm font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          Try Again
        </a>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MotdModalProps {
  title: string;
  body: string;
}

const SESSION_KEY = "motd_dismissed";

export function MotdModal({ title, body }: MotdModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!body) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;
    setVisible(true);
  }, [body]);

  function dismiss() {
    sessionStorage.setItem(SESSION_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-5 h-5" />
        </button>

        {title && (
          <h2 className="text-lg font-bold text-white mb-3 pr-8">{title}</h2>
        )}

        <p className="text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">{body}</p>

        <div className="mt-6 flex justify-end">
          <Button onClick={dismiss} className="bg-indigo-600 hover:bg-indigo-500">
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

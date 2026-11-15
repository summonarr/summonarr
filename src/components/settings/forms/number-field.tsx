"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// A labelled number box with its help line, as the play-history and watch-grade
// settings forms lay them out. The value stays the typed string: the form sends
// it as is and the route validates it.
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  placeholder,
  help,
  wide,
}: {
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  help?: React.ReactNode;
  // Fill the column instead of the fixed short box (forms laid out in a grid).
  wide?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={wide ? "bg-zinc-800 border-zinc-700" : "bg-zinc-800 border-zinc-700 w-32"}
      />
      {help != null && <p className="text-xs text-zinc-500">{help}</p>}
    </div>
  );
}

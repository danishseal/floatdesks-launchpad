"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  denom: string;
  presets?: number[];
  error?: string;
  disabled?: boolean;
}

function formatPreset(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return n.toString();
}

export function AmountInput({
  value,
  onChange,
  label,
  denom,
  presets = [0.1, 0.5, 1, 5],
  error,
  disabled,
}: AmountInputProps) {
  return (
    <div className="space-y-2">
      <Label className="text-zinc-700">{label}</Label>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`0.00 ${denom}`}
        className={error ? "min-h-[44px] border-zinc-400" : "min-h-[44px]"}
        disabled={disabled}
      />
      <div className="grid grid-cols-2 gap-2">
        {presets.map((amount) => (
          <Button
            key={amount}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(amount.toString())}
            disabled={disabled}
            className="min-h-[44px] w-full touch-manipulation"
          >
            {formatPreset(amount)} {denom}
          </Button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

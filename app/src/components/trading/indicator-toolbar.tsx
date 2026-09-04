"use client";

export interface ActiveIndicators {
  sma7: boolean;
  sma25: boolean;
  sma99: boolean;
  ema7: boolean;
  ema25: boolean;
  bollinger: boolean;
  rsi: boolean;
  macd: boolean;
  volume: boolean;
}

export const DEFAULT_INDICATORS: ActiveIndicators = {
  sma7: false,
  sma25: false,
  sma99: false,
  ema7: false,
  ema25: false,
  bollinger: false,
  rsi: false,
  macd: false,
  volume: true,
};

interface IndicatorToolbarProps {
  indicators: ActiveIndicators;
  onChange: (indicators: ActiveIndicators) => void;
}

const INDICATOR_BUTTONS: { key: keyof ActiveIndicators; label: string; color: string }[] = [
  { key: "sma7", label: "MA7", color: "#4367d8" },
  { key: "sma25", label: "MA25", color: "#5b7ae0" },
  { key: "sma99", label: "MA99", color: "#3556be" },
  { key: "ema7", label: "EMA7", color: "#8aa0ec" },
  { key: "ema25", label: "EMA25", color: "#2747a7" },
  { key: "bollinger", label: "BOLL", color: "#4367d8" },
  { key: "rsi", label: "RSI", color: "#6d87e5" },
  { key: "macd", label: "MACD", color: "#4c6fdb" },
  { key: "volume", label: "VOL", color: "#6b7280" },
];

export function IndicatorToolbar({ indicators, onChange }: IndicatorToolbarProps) {
  const toggle = (key: keyof ActiveIndicators) => {
    onChange({ ...indicators, [key]: !indicators[key] });
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {INDICATOR_BUTTONS.map(({ key, label, color }) => (
        <button
          key={key}
          type="button"
          onClick={() => toggle(key)}
          className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
            indicators[key]
              ? "border-transparent text-zinc-900"
              : "border-[var(--color-border-soft)] bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-surface)]"
          }`}
          style={indicators[key] ? { backgroundColor: color } : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

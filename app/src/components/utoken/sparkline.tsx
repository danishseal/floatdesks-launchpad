"use client";

import { useMemo } from "react";
import { useCandles } from "@/hooks/use-candles";

/**
 * 72×26 sparkline from a token's recent candles: a direction-colored polyline
 * (2px) over a 10%-opacity area fill (utoken spec §6). Flat baseline until loaded.
 */
export function Sparkline({
  address,
  up,
  width = 72,
  height = 26,
}: {
  address: string;
  up: boolean;
  width?: number;
  height?: number;
}) {
  const { data } = useCandles(address, "1h");
  const geom = useMemo(() => {
    const closes = (data?.candles ?? []).slice(-24).map((k) => Number(k.close));
    if (closes.length < 2) return null;
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const pts = closes.map((v, i) => {
      const x = (i / (closes.length - 1)) * width;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return [x, y] as const;
    });
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `${pts[0][0].toFixed(1)},${height} ${line} ${pts[pts.length - 1][0].toFixed(1)},${height}`;
    return { line, area };
  }, [data, width, height]);

  const color = up ? "#166f3d" : "#a73520";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {geom ? (
        <>
          <polygon points={geom.area} fill={color} opacity={0.1} />
          <polyline points={geom.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </>
      ) : (
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="#3a3a3c" strokeWidth={2} />
      )}
    </svg>
  );
}

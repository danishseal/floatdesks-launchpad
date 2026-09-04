"use client";

import type { ReactNode } from "react";
import { BackgroundSquares } from "@/components/layout/background-squares";

export function PixelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="pixel-frame">
      <div className="pixel-frame__canvas" aria-hidden="true">
        <BackgroundSquares />
      </div>
      <div className="pixel-frame__window">{children}</div>
    </div>
  );
}

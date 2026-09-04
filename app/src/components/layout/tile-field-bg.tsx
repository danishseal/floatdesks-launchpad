"use client";

/**
 * Global animated backdrop ported from utoken's HeroField.
 *
 * A canvas grid of small squares arranged in seeded clusters, faded radially
 * toward a focus point. Periodic "sweeps" light up rows in a travelling wave,
 * and tiles near the pointer glow. Rendered fixed behind all app content
 * (pointer-events off, low z-index) so it never blocks clicks. Respects
 * prefers-reduced-motion. The tile ink is read from the --hero-ink CSS var
 * (ANSEM green) so it stays on-brand.
 */

import { useEffect, useRef } from "react";

type Tile = {
  x: number;
  y: number;
  centerX: number;
  centerY: number;
  key: string;
  fade: number;
  base: number;
  latent: number;
};

type Field = {
  tiles: Tile[];
  width: number;
  height: number;
  columns: number;
  rows: number;
  square: number;
  color: string;
};

type Sweep = { column: number; row: number; startedAt: number };

const GRID = 11;
const SQUARE = 8;

function seeded(column: number, row: number) {
  let hash = (0x165667b1 * column + 0x27d4eb2f * row) ^ 0x5f3759df;
  hash = Math.imul(hash ^ (hash >>> 13), 0x4bf19f61);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
}

function makeClusters(
  columns: number,
  rows: number,
  offset: number,
  density: number,
) {
  const result = new Set<string>();

  for (let row = 0; row < rows; row += 1) {
    let column = 0;
    while (column < columns) {
      if (seeded(column + offset, row) < density) {
        const run = 1 + Math.floor(4 * seeded(column + offset + 7919, row));
        for (let i = 0; i < run && column + i < columns; i += 1) {
          result.add(`${column + i}:${row}`);
        }
        column +=
          run + 1 + Math.floor(3 * seeded(column + offset + 104729, row));
      } else {
        column += 1;
      }
    }
  }

  return result;
}

function buildField(canvas: HTMLCanvasElement): Field | null {
  const context = canvas.getContext("2d");
  if (!context) return null;

  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;

  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const columns = Math.ceil(bounds.width / GRID);
  const rows = Math.ceil(bounds.height / GRID);
  const visible = makeClusters(columns, rows, 0, 0.26);
  const latent = makeClusters(columns, rows, 55001, 0.11);
  const focusX = bounds.width < 1024 ? bounds.width / 2 : bounds.width * 0.54;
  const focusY = bounds.height * 0.46;
  const radius = Math.hypot(
    Math.max(focusX, bounds.width - focusX),
    1.3 * Math.max(focusY, bounds.height - focusY),
  );
  const mobileOpacity = bounds.width < 640 ? 0.7 : 1;
  const tiles: Tile[] = [];

  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const key = `${column}:${row}`;
      const isVisible = visible.has(key);
      if (!isVisible && !latent.has(key)) continue;

      const x = column * GRID;
      const y = row * GRID;
      const centerX = x + SQUARE / 2;
      const centerY = y + SQUARE / 2;
      const distance =
        Math.hypot(centerX - focusX, (centerY - focusY) * 1.3) / radius;
      const radial = Math.max(0.38, 1 - distance * 0.78);
      const edgeDistance = Math.min(
        x,
        y,
        bounds.width - x - SQUARE,
        bounds.height - y - SQUARE,
      );
      const edge = 0.55 + 0.45 * Math.max(0, Math.min(1, edgeDistance / 32));
      const fade = radial * edge;
      if (fade <= 0.01) continue;

      const noise = seeded(column, row);
      tiles.push({
        x,
        y,
        centerX,
        centerY,
        key,
        fade,
        base: isVisible ? (0.07 + 0.15 * noise) * fade * mobileOpacity : 0,
        latent: isVisible ? 0 : (0.05 + 0.09 * noise) * fade * mobileOpacity,
      });
    }
  }

  const ink = getComputedStyle(canvas).getPropertyValue("--hero-ink").trim();
  const color = `rgb(${ink || "108 240 127"})`;

  context.clearRect(0, 0, bounds.width, bounds.height);
  context.fillStyle = color;
  for (const tile of tiles) {
    if (tile.base < 0.006) continue;
    context.globalAlpha = tile.base;
    context.fillRect(tile.x, tile.y, SQUARE, SQUARE);
  }
  context.globalAlpha = 1;

  return {
    tiles,
    width: bounds.width,
    height: bounds.height,
    columns,
    rows,
    square: SQUARE,
    color,
  };
}

export function TileFieldBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const supportsHover = window.matchMedia("(hover: hover)").matches;
    let field = buildField(canvas);
    if (!field) return;

    let frame = 0;
    let delayedFrame: ReturnType<typeof setTimeout> | undefined;
    let visible = true;
    let pointerTarget = 0;
    let pointerStrength = 0;
    let pointerX = 0;
    let pointerY = 0;
    let smoothedX = 0;
    let smoothedY = 0;
    let nextSweep = performance.now() + 700;
    let sweepPattern = 0;
    const sweeps: Sweep[] = [];
    const highlighted = new Map<string, number>();

    const randomInt = (min: number, max: number, total: number) =>
      Math.round(total * (min + Math.random() * (max - min)));

    const addSweep = (now: number) => {
      if (!field) return;
      sweepPattern = (sweepPattern + 1) % 3;
      const row =
        sweepPattern === 0
          ? randomInt(0.03, 0.14, field.rows)
          : sweepPattern === 1
            ? randomInt(0.86, 0.97, field.rows)
            : randomInt(0.2, 0.62, field.rows);
      const column =
        sweepPattern === 0
          ? randomInt(0.05, 0.72, field.columns)
          : sweepPattern === 1
            ? randomInt(0.04, 0.66, field.columns)
            : randomInt(0.62, 0.86, field.columns);
      sweeps.push({ column, row, startedAt: now });
      nextSweep = now + 1200 + 1800 * Math.random();
    };

    const draw = (now: number) => {
      frame = 0;
      if (!field || !visible) return;

      if (now >= nextSweep) addSweep(now);
      pointerStrength += (pointerTarget - pointerStrength) * 0.09;
      smoothedX += (pointerX - smoothedX) * 0.16;
      smoothedY += (pointerY - smoothedY) * 0.16;

      context.clearRect(0, 0, field.width, field.height);
      context.fillStyle = field.color;
      highlighted.clear();

      for (let index = sweeps.length - 1; index >= 0; index -= 1) {
        const sweep = sweeps[index];
        const elapsed = now - sweep.startedAt;
        if (elapsed > 1634) {
          sweeps.splice(index, 1);
          continue;
        }
        for (let step = 0; step < 18; step += 1) {
          const progress = (elapsed - 38 * step) / 950;
          if (progress <= 0 || progress >= 1) continue;
          highlighted.set(
            `${sweep.column + step}:${sweep.row}`,
            progress < 0.15 ? progress / 0.15 : 1 - (progress - 0.15) / 0.85,
          );
        }
      }

      const pointerActive = pointerStrength > 0.004;
      for (const tile of field.tiles) {
        let opacity = tile.base;
        const sweep = highlighted.get(tile.key);
        if (sweep) {
          opacity += sweep * (tile.base > 0 ? 0.55 : 0.4) * tile.fade;
        }

        let glow = 0;
        if (pointerActive) {
          const deltaX = tile.centerX - smoothedX;
          const deltaY = tile.centerY - smoothedY;
          if (deltaX > -180 && deltaX < 180 && deltaY > -88 && deltaY < 88) {
            const wide = 1 - (deltaX / 180) ** 2 - (deltaY / 34) ** 2;
            const round = 1 - (deltaX / 88) ** 2 - (deltaY / 88) ** 2;
            const intensity = Math.max(wide, round);
            if (intensity > 0) {
              glow = intensity ** 2 * pointerStrength;
              opacity +=
                tile.base > 0
                  ? 0.12 * glow * tile.fade
                  : tile.latent * glow ** 2 * 2;
            }
          }
        }

        if (opacity < 0.006) continue;
        context.globalAlpha = Math.min(0.42, opacity);
        if (glow > 0.05) {
          const expansion = glow / 2;
          context.fillRect(
            tile.x - expansion,
            tile.y - expansion,
            field.square + glow,
            field.square + glow,
          );
        } else {
          context.fillRect(tile.x, tile.y, field.square, field.square);
        }
      }
      context.globalAlpha = 1;

      if (sweeps.length > 0 || pointerStrength > 0.004 || pointerTarget > 0) {
        frame = requestAnimationFrame(draw);
      } else {
        delayedFrame = setTimeout(
          () => {
            delayedFrame = undefined;
            if (visible && !frame) frame = requestAnimationFrame(draw);
          },
          Math.max(16, nextSweep - performance.now()),
        );
      }
    };

    const wake = () => {
      if (frame || !visible) return;
      if (delayedFrame) clearTimeout(delayedFrame);
      delayedFrame = undefined;
      frame = requestAnimationFrame(draw);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (delayedFrame) clearTimeout(delayedFrame);
      delayedFrame = undefined;
    };

    const rebuild = () => {
      field = buildField(canvas);
      if (!reducedMotion) wake();
    };

    const resizeObserver = new ResizeObserver(rebuild);
    resizeObserver.observe(canvas);

    if (reducedMotion) {
      return () => resizeObserver.disconnect();
    }

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) {
          nextSweep = performance.now() + 400;
          wake();
        } else {
          stop();
        }
      },
      { rootMargin: "120px" },
    );
    intersectionObserver.observe(canvas);

    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const nearby =
        x > -60 && y > -60 && x < bounds.width + 60 && y < bounds.height + 60;
      pointerTarget = nearby ? 1 : 0;
      if (nearby) {
        pointerX = x;
        pointerY = y;
        if (pointerStrength < 0.005) {
          smoothedX = x;
          smoothedY = y;
        }
        wake();
      }
    };

    const onPointerLeave = () => {
      pointerTarget = 0;
      wake();
    };

    if (supportsHover) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerleave", onPointerLeave);
    }
    wake();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      if (supportsHover) {
        window.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerleave", onPointerLeave);
      }
    };
  }, []);

  // Solid background everywhere (per user): the animated tile field is disabled.
  // The effect above no-ops without a canvas, and the body's solid #161616 shows
  // through on every page. Kept as a component so the layout import stays stable.
  return null;
}

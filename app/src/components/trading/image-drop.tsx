"use client";

/**
 * Drop a logo in, or paste a URL.
 *
 * The important constraint is where the bytes go. There is no pinning service
 * configured here and `uploadImage()` in lib/api.ts is an ansem-era stub that
 * throws, so a dropped file has exactly one destination that actually works:
 * the launch metadata itself, which `buildTokenMetaUri` already writes on chain
 * as a `data:application/json,...` blob. The image becomes a `data:` URI inside
 * that JSON.
 *
 * That makes size a real cost rather than a preference. Storing bytes on chain
 * is `ceil(bytes/32) * 20000` gas of cold SSTORE plus 16 gas per calldata byte,
 * so at the 0.40 gwei this chain was quoting, 4KB is about 0.001 ETH and 32KB is
 * about 0.0085 ETH. A phone photo dropped in raw would be megabytes and simply
 * would not send. So the file is downscaled to a logo and re-encoded until it
 * fits a budget, and the cost is shown from the CHAIN'S OWN gas price rather
 * than a number typed in here. If that price cannot be read, the size is shown
 * and the cost says it is unknown, because a plausible cost is worse than none.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Spinner, X } from "@phosphor-icons/react";
import { publicClient } from "@/lib/float/chain";
import { resolveTokenImage } from "@/components/token/token-art";

/** Logo box. Bigger buys nothing on a 56px avatar and costs gas per byte. */
// 128 was sharp in a 44px avatar and mush everywhere else: the launchpad grid
// renders these cards several hundred pixels wide, so every logo was being
// upscaled roughly three times and looked it. 320 is sharp at the largest
// place we draw them and still lands well inside HARD_MAX_BYTES once the
// quality ladder below has run, and the wizard prices the extra bytes as gas
// before anyone commits to them.
const MAX_EDGE = 320;
/** Encoded budget. 6KB is about 0.0016 ETH at 0.40 gwei. */
const TARGET_BYTES = 6 * 1024;
/** Refuse above this: it is a launch cost the launcher did not agree to. */
const HARD_MAX_BYTES = 24 * 1024;

const FIELD =
  "w-full rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-bg-page)] px-3.5 py-2.5 text-[15px] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--color-text-primary)]";

function isDataUri(v: string) {
  return v.startsWith("data:");
}

/** Bytes the URI itself will occupy in the stored blob. */
function byteLength(v: string) {
  return new TextEncoder().encode(v).length;
}

function prettyBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * Cold SSTORE per 32-byte word plus non-zero calldata. The launch writes this
 * blob once, so this is the marginal gas the image adds, not the whole tx.
 */
function storageGas(bytes: number) {
  return Math.ceil(bytes / 32) * 20000 + bytes * 16;
}

/**
 * Decode to something drawable.
 *
 * Vectors go through an <img> rather than createImageBitmap, which rasterises
 * an SVG once at its intrinsic size: an icon authored at 24px would be baked
 * to a 24px raster and then blown up, and an SVG with only a viewBox has no
 * intrinsic size at all. Drawn from an <img>, the browser re-rasterises the
 * vector at the destination size, so it comes out sharp at MAX_EDGE.
 */
async function decode(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  vector: boolean;
  done: () => void;
}> {
  if (file.type === "image/svg+xml") {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "sync";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("that SVG would not render"));
        img.src = url;
      });
      // A viewBox-only SVG reports the 300x150 default replaced-element box.
      // Its aspect is still right, so it is kept and only the scale is taken
      // from MAX_EDGE.
      const w = img.naturalWidth || MAX_EDGE;
      const h = img.naturalHeight || MAX_EDGE;
      return { source: img, width: w, height: h, vector: true, done: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
  const bitmap = await createImageBitmap(file);
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    vector: false,
    done: () => bitmap.close(),
  };
}

/** Draw to a square canvas, then walk quality down until it fits. */
async function encodeToBudget(file: File): Promise<{ uri: string; bytes: number }> {
  const { source, width, height, vector, done } = await decode(file);
  // Never upscale a raster: a 64px PNG stored at 320px is the same 64px of
  // detail in five times the bytes. A vector has no such ceiling.
  const edge = vector ? MAX_EDGE : Math.min(MAX_EDGE, Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    done();
    throw new Error("this browser gave no 2d canvas to resize with");
  }
  // Default smoothing is "low", which on a big downscale drops most of the
  // source pixels instead of averaging them and reads as aliased mush.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Cover-fit into the square so a wide logo is not squashed.
  const scale = Math.max(edge / width, edge / height);
  const w = width * scale;
  const h = height * scale;
  ctx.drawImage(source, (edge - w) / 2, (edge - h) / 2, w, h);
  done();

  // WebP first, PNG only as a fallback: a browser that cannot encode WebP
  // silently hands back a PNG data URI from toDataURL, so the type is checked
  // rather than assumed.
  let best: { uri: string; bytes: number } | null = null;
  for (const quality of [0.85, 0.7, 0.55, 0.4, 0.3]) {
    const uri = canvas.toDataURL("image/webp", quality);
    const bytes = byteLength(uri);
    best = { uri, bytes };
    if (bytes <= TARGET_BYTES) return best;
  }
  const png = canvas.toDataURL("image/png");
  if (byteLength(png) < (best?.bytes ?? Infinity)) best = { uri: png, bytes: byteLength(png) };
  if (!best) throw new Error("could not encode that image");
  return best;
}

export function ImageDrop({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The chain's own price. Read once; if it will not answer, the cost is
  // reported as unknown rather than guessed.
  useEffect(() => {
    let alive = true;
    publicClient()
      .getGasPrice()
      .then((p) => alive && setGasPrice(p))
      .catch(() => alive && setGasPrice(null));
    return () => {
      alive = false;
    };
  }, []);

  const take = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError(`${file.name} is ${file.type || "not an image"}`);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const { uri, bytes } = await encodeToBudget(file);
        if (bytes > HARD_MAX_BYTES) {
          setError(
            `That encodes to ${prettyBytes(bytes)}, over the ${prettyBytes(HARD_MAX_BYTES)} cap. Try a flatter image.`,
          );
          return;
        }
        onChange(uri);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not read that file");
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  // A pasted ipfs:// URI is not something a browser will fetch, so the preview
  // shows what the app will actually draw rather than the raw string.
  const preview = resolveTokenImage(value);
  const bytes = value && isDataUri(value) ? byteLength(value) : 0;
  const gas = bytes ? storageGas(bytes) : 0;
  const eth = gas && gasPrice ? (Number(gasPrice) * gas) / 1e18 : null;

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files?.[0]);
        }}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Drop a logo here, or click to choose one"
        className={`flex cursor-pointer items-center gap-3.5 rounded-[10px] border border-dashed px-3.5 py-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-text-primary)] ${
          dragging
            ? "border-[var(--color-text-primary)] bg-[var(--color-bg-raised)]"
            : "border-[var(--color-border-soft)] bg-[var(--color-bg-page)] hover:border-[var(--color-text-muted)]"
        }`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="h-12 w-12 shrink-0 rounded-full border border-[var(--color-border-soft)] object-cover"
          />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]">
            {busy ? <Spinner size={18} className="animate-spin" /> : <ImageIcon size={18} />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-[var(--color-text-primary)]">
            {busy ? "Resizing…" : dragging ? "Drop it" : value ? "Replace logo" : "Drag a logo here"}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-[var(--color-text-subtle)]">
            {bytes
              ? `${prettyBytes(bytes)} stored on chain${
                  eth === null ? ", cost unknown" : `, about ${eth.toFixed(5)} ETH of gas`
                }`
              : value
                ? "Linked, not stored on chain"
                : `PNG, JPEG, WebP or SVG. Squared to ${MAX_EDGE}px and re-encoded to fit.`}
          </span>
        </span>
        {value ? (
          <button
            type="button"
            aria-label="Remove logo"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
              setError(null);
            }}
            className="shrink-0 rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]"
          >
            <X size={14} weight="bold" />
          </button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {error ? (
        <p className="text-[12px] text-[var(--color-negative)]">{error}</p>
      ) : null}

      <input
        className={FIELD}
        value={isDataUri(value) ? "" : value}
        placeholder="or paste ipfs:// or https://"
        onChange={(e) => onChange(e.target.value)}
        aria-label="Image URL"
      />
    </div>
  );
}

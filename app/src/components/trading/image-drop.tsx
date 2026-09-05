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

/** Logo box. Bigger buys nothing on a 56px avatar and costs gas per byte. */
const MAX_EDGE = 128;
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

/** Draw to a square canvas, then walk quality down until it fits. */
async function encodeToBudget(file: File): Promise<{ uri: string; bytes: number }> {
  const bitmap = await createImageBitmap(file);
  const edge = Math.min(MAX_EDGE, Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser gave no 2d canvas to resize with");

  // Cover-fit into the square so a wide logo is not squashed.
  const scale = Math.max(edge / bitmap.width, edge / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (edge - w) / 2, (edge - h) / 2, w, h);
  bitmap.close();

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
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
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

"use client";

import { useRef, useState, type DragEvent } from "react";
import { Camera, Trash, User, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { saveProfile, type Profile } from "@/lib/social";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";

/** Cap the decoded size of an inline image data URL (stored inside the JSON profile). */
const MAX_IMAGE_BYTES = 900 * 1024;

/**
 * Read an image file, downscale it on a canvas, and return a compressed data URL.
 * Avatars are capped on their long edge, banners on their width, aspect preserved.
 */
async function downscaleImage(
  file: File,
  opts: { maxEdge: number },
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file isn't an image. Pick a PNG, JPG, or WebP.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That image couldn't be decoded."));
    el.src = dataUrl;
  });

  const scale = Math.min(1, opts.maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image processing isn't available in this browser.");
  ctx.drawImage(img, 0, 0, w, h);

  // Prefer WebP; fall back to JPEG if the browser encodes to something else.
  let out = canvas.toDataURL("image/webp", 0.85);
  if (!out.startsWith("data:image/webp")) {
    out = canvas.toDataURL("image/jpeg", 0.85);
  }

  const b64 = out.split(",")[1] ?? "";
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error("That image is too large even after resizing. Try a smaller one.");
  }
  return out;
}

/** Edit-profile modal. Saves to the server, authenticated by a wallet signature. */
export function ProfileEditModal({
  address,
  initial,
  onClose,
  onSaved,
}: {
  address: string;
  initial: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const wallet = useFloorWallet();
  const [form, setForm] = useState<Profile>(initial);
  const [saving, setSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  function set<K extends keyof Profile>(k: K, v: string) {
    if (k === "username") setUsernameError(null);
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    // Guard the not-connected case loudly instead of failing silently mid-sign.
    if (!wallet.address) {
      toast.error("Connect your wallet first");
      try {
        await wallet.connect();
      } catch {
        /* connect UI surfaces its own errors */
      }
      return;
    }
    setSaving(true);
    setUsernameError(null);
    try {
      await saveProfile(address, form, wallet);
      toast.success("Profile saved");
      onSaved();
      onClose();
    } catch (e) {
      // A taken username is a fixable input error: keep the modal open and show
      // it inline on the field rather than a generic toast.
      const code = (e as { code?: string })?.code;
      if (code === "username_taken") {
        setUsernameError(e instanceof Error ? e.message : "That username is taken");
      } else {
        toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setSaving(false);
    }
  }

  const field =
    "h-10 w-full rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--hairline-strong)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--hairline-strong)] bg-[var(--color-bg-surface)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--color-bg-surface)] px-5 py-3.5">
          <h2 className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">Edit profile</h2>
          <button type="button" onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {/* Banner + submerged avatar, composed the way they read on the profile. */}
          <ProfileImages
            banner={form.banner}
            avatar={form.avatar}
            onBanner={(v) => set("banner", v)}
            onAvatar={(v) => set("avatar", v)}
          />

          <Labeled label="Username">
            <div
              className={`flex h-10 items-center rounded-lg border bg-[var(--color-bg-raised)] px-3 ${
                usernameError
                  ? "border-red-500/60"
                  : "border-[var(--hairline)] focus-within:border-[var(--hairline-strong)]"
              }`}
            >
              <span className="text-[14px] text-[var(--color-text-muted)]">@</span>
              <input
                className="h-full flex-1 bg-transparent px-1 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)]"
                value={form.username ?? ""}
                onChange={(e) => set("username", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
                placeholder="satoshi"
                maxLength={20}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {usernameError ? (
              <span className="mt-1 block text-[11px] text-red-400">{usernameError}. Pick another.</span>
            ) : (
              <span className="mt-1 block text-[11px] text-[var(--color-text-subtle)]">3-20 chars: letters, numbers, underscore. People can find you by @username.</span>
            )}
          </Labeled>
          <Labeled label="Display name">
            <input className={field} value={form.displayName ?? ""} onChange={(e) => set("displayName", e.target.value)} placeholder="satoshi" maxLength={40} />
          </Labeled>
          <Labeled label="Bio">
            <textarea
              className="w-full resize-none rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 py-2 text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-subtle)] focus:border-[var(--hairline-strong)]"
              rows={2}
              value={form.bio ?? ""}
              onChange={(e) => set("bio", e.target.value)}
              placeholder="A short bio"
              maxLength={160}
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="X / Twitter">
              <input className={field} value={form.twitter ?? ""} onChange={(e) => set("twitter", e.target.value)} placeholder="@handle" />
            </Labeled>
            <Labeled label="Telegram">
              <input className={field} value={form.telegram ?? ""} onChange={(e) => set("telegram", e.target.value)} placeholder="t.me/…" />
            </Labeled>
          </div>
          <p className="text-[11px] leading-4 text-[var(--color-text-subtle)]">
            Saving signs a message with your wallet to prove it&apos;s you. No gas, no transaction.
          </p>
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--color-bg-surface)] px-5 py-3.5">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-[var(--hairline)] px-4 text-[13px] text-[var(--color-text-secondary)] hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)]">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={saving} className="h-9 rounded-lg bg-[var(--color-accent-solid)] px-4 text-[13px] font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-50">
            {saving ? "Signing…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Banner + avatar header. The avatar is submerged into the banner's bottom-left
 * corner (overlapping only the banner image), while the banner size hint and the
 * avatar's own controls sit to the right of the avatar's overhang so nothing is
 * ever covered. Both keep the click-to-upload + downscale behaviour.
 */
function ProfileImages({
  banner,
  avatar,
  onBanner,
  onAvatar,
}: {
  banner?: string;
  avatar?: string;
  onBanner: (v: string) => void;
  onAvatar: (v: string) => void;
}) {
  const bannerInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [bannerDrag, setBannerDrag] = useState(false);
  const [avatarDrag, setAvatarDrag] = useState(false);

  // Shared drag-and-drop handlers: drop an image straight onto the banner/avatar.
  function dropHandlers(
    onFile: (f: File | undefined) => void,
    setDrag: (v: boolean) => void,
  ) {
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setDrag(true);
      },
      onDragLeave: (e: DragEvent) => {
        e.preventDefault();
        setDrag(false);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDrag(false);
        void onFile(e.dataTransfer.files?.[0]);
      },
    };
  }

  async function onBannerFile(file: File | undefined) {
    if (!file) return;
    setBannerBusy(true);
    try {
      onBanner(await downscaleImage(file, { maxEdge: 1200 }));
    } catch (e) {
      toast.error("Couldn't use that image", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBannerBusy(false);
      if (bannerInput.current) bannerInput.current.value = "";
    }
  }

  async function onAvatarFile(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    try {
      onAvatar(await downscaleImage(file, { maxEdge: 512 }));
    } catch (e) {
      toast.error("Couldn't use that image", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAvatarBusy(false);
      if (avatarInput.current) avatarInput.current.value = "";
    }
  }

  return (
    <div>
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">Banner</span>
      {/* Banner with the avatar submerged into its bottom-left corner */}
      <div className="relative">
        <button
          type="button"
          onClick={() => bannerInput.current?.click()}
          {...dropHandlers(onBannerFile, setBannerDrag)}
          className={`group relative block aspect-[3.8/1] w-full overflow-hidden rounded-xl border bg-[var(--color-bg-raised)] transition-colors ${bannerDrag ? "border-[var(--color-accent-solid)] ring-2 ring-[var(--color-accent-solid)]" : "border-[var(--hairline)]"}`}
        >
          {banner ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={banner} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#1f2a20] via-[#1c1c1e] to-[#161616]" />
          )}
          <span className={`absolute inset-0 flex items-center justify-center gap-1.5 bg-black/40 text-[12px] font-medium text-[var(--color-text-primary)] transition-opacity ${bannerDrag ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            <Camera size={16} weight="fill" /> {bannerBusy ? "Processing…" : bannerDrag ? "Drop to set banner" : banner ? "Change banner" : "Upload or drop banner"}
          </span>
        </button>
        {/* Submerged avatar: overlaps only the banner, ring-cutout like the profile */}
        <button
          type="button"
          onClick={() => avatarInput.current?.click()}
          {...dropHandlers(onAvatarFile, setAvatarDrag)}
          className={`group absolute -bottom-8 left-4 h-20 w-20 overflow-hidden rounded-full border-2 border-[var(--color-bg-surface)] bg-[var(--color-bg-raised)] ring-4 transition-colors ${avatarDrag ? "ring-[var(--color-accent-solid)]" : "ring-[var(--color-bg-surface)]"}`}
        >
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
              <User size={34} weight="fill" />
            </span>
          )}
          <span className={`absolute inset-0 flex items-center justify-center bg-black/45 text-[var(--color-text-primary)] transition-opacity ${avatarBusy || avatarDrag ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            <Camera size={18} weight="fill" />
          </span>
        </button>
      </div>

      {/* Banner size hint on its own line, cleared to the right of the avatar */}
      <div className="mt-1.5 flex items-center gap-3 pl-[108px]">
        <span className="text-[11px] text-[var(--color-text-subtle)]">Click or drag an image in. Wide, ~3.8:1, downscaled to 1200px. Avatar too.</span>
        {banner && (
          <button type="button" onClick={() => onBanner("")} className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
            <Trash size={12} /> Remove
          </button>
        )}
      </div>

      {/* Avatar controls, sitting beside the avatar's overhang - clear of the hint */}
      <div className="mt-2.5 flex items-center gap-3 pl-[108px]">
        <button type="button" onClick={() => avatarInput.current?.click()} className="text-[12px] font-medium text-[var(--color-accent-strong)] hover:underline">
          {avatarBusy ? "Processing…" : avatar ? "Change avatar" : "Upload avatar"}
        </button>
        {avatar && (
          <button type="button" onClick={() => onAvatar("")} className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
            <Trash size={12} /> Remove
          </button>
        )}
      </div>

      <input ref={bannerInput} type="file" accept="image/*" className="hidden" onChange={(e) => onBannerFile(e.target.files?.[0])} />
      <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={(e) => onAvatarFile(e.target.files?.[0])} />
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--color-text-secondary)]">{label}</span>
      {children}
    </label>
  );
}

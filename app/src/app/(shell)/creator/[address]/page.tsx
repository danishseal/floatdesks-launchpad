"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  CopySimple,
  Horse,
  SealCheck,
  ShareNetwork,
  User,
  XLogo,
} from "@phosphor-icons/react";
import { useTokens } from "@/hooks/use-tokens";
import { fetchWalletTokens, type TokenListItem } from "@/lib/api";
import { TokenCard } from "@/components/feed/token-card";
import { ActivityFeed } from "@/components/utoken/activity";
import { ProfilePosts } from "@/components/utoken/feed";
import { ProfileEditModal } from "@/components/utoken/profile-edit";
import { FollowListModal, type FollowTab } from "@/components/utoken/follow-list";
import { useProfile, useGraph, setFollow } from "@/lib/social";
import { resolveIdentity } from "@/components/social/shared";
import { useFloorWallet } from "@/components/wallet/solana-wallet-provider";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { REST_URL, BASE_DENOMS } from "@/lib/floorlaunch/config";
import { TelegramLogo, PencilSimple, UserPlus, ChatCircle } from "@phosphor-icons/react";

type Tab = "posts" | "holdings" | "launches" | "activity";

export default function CreatorPage() {
  const params = useParams();
  const rawAddress = params.address as string;
  // Route params can arrive percent-encoded; bech32 addresses have no special
  // characters, but decode defensively so the owner compare below is exact.
  const address = useMemo(() => {
    try {
      return decodeURIComponent(rawAddress);
    } catch {
      return rawAddress;
    }
  }, [rawAddress]);
  const [tab, setTab] = useState<Tab>("posts");
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  // A token-owned account (claimed without a wallet) lives at a SYNTHETIC owner
  // id `token-<username>`, not a bech32 `ansem1...` address. It is a real,
  // publicly viewable profile, but it has no on-chain presence — so every query
  // that hits the chain (bank balances, wallet token holdings) MUST be skipped
  // for it, or those lookups would error / 404 on a non-address slug. Real wallet
  // owners are `ansem1...`; guard on that prefix.
  const isOnchainAddress = address.startsWith("ansem1");

  const { data: tokens } = useTokens();
  const holdings = useQuery({
    queryKey: ["wallet", "tokens", address],
    queryFn: () => fetchWalletTokens(address),
    enabled: Boolean(address) && isOnchainAddress,
    staleTime: 30_000,
  });

  // Native ANSEM + CHANSE balances for THIS profile address, straight from the
  // chain REST bank module. Works for any address, not just the connected one.
  const nativeBalances = useQuery({
    queryKey: ["native-balances", address],
    enabled: Boolean(address) && isOnchainAddress,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`${REST_URL}/cosmos/bank/v1beta1/balances/${address}`);
      if (!res.ok) throw new Error(`balances ${res.status}`);
      const json = (await res.json()) as { balances?: { denom: string; amount: string }[] };
      const find = (denom: string) =>
        Number(json.balances?.find((b) => b.denom === denom)?.amount ?? 0) / 1e6;
      return {
        ansem: find(BASE_DENOMS.ansem),
        chanse: find(BASE_DENOMS.chanse),
      };
    },
  });

  const launches = useMemo(
    () => (tokens ?? []).filter((t) => t.creator === address),
    [tokens, address],
  );

  // Any social linked on one of their coins -> show a linked badge + X handle.
  const twitter = useMemo(
    () => launches.map((t) => t.listing.links?.twitter).find(Boolean),
    [launches],
  );

  const tokenAvatar = launches.find((t) => t.image)?.image ?? null;

  // Social layer (real backend): profile overrides + follow graph.
  const wallet = useFloorWallet();
  const queryClient = useQueryClient();
  const profileQ = useProfile(address);
  const profile = profileQ.data ?? {};
  const graphQ = useGraph(address, wallet.address);
  const graph = graphQ.data;
  const [showEdit, setShowEdit] = useState(false);
  const [followList, setFollowList] = useState<FollowTab | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const isOwn = wallet.address != null && wallet.address === address;

  async function handleFollow() {
    if (!wallet.address) {
      toast.error("Connect your wallet first");
      try {
        await wallet.connect();
      } catch {
        /* connect UI surfaces its own errors */
      }
      return;
    }
    setFollowBusy(true);
    try {
      await setFollow(wallet.address, address, !graph?.viewerFollows, wallet);
      await queryClient.invalidateQueries({ queryKey: ["social", "graph", address] });
    } catch (e) {
      toast.error("Follow failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFollowBusy(false);
    }
  }

  const avatarImage = profile.avatar || tokenAvatar;
  const bannerImage = profile.banner;
  // X-style identity: display name (bold) on top, muted @username beneath when
  // both exist. `identity.name` also seeds the share-sheet title.
  const identity = resolveIdentity(profile, address);
  const displayName = identity.name;
  const twitterLink = profile.twitter || twitter;
  const telegramLink = profile.telegram;
  const handle = shortHandle(address);

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  async function handleShare() {
    const url = `${window.location.origin}/creator/${address}`;
    const title = `${displayName} on ansemchain`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ url, title });
        return;
      } catch (e) {
        // User dismissed the share sheet: nothing to do.
        if (e instanceof Error && e.name === "AbortError") return;
        // Otherwise fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      toast.success("Profile link copied");
      window.setTimeout(() => setShared(false), 1_500);
    } catch {
      toast.error("Could not copy link");
    }
  }

  return (
    <div className="min-h-[calc(100vh-56px)] text-[var(--color-text-primary)]">
      <div className="pb-10">
        {/* Banner - spans the full container width, aligned to the nav edges */}
        <div className="relative h-[200px] w-full overflow-hidden rounded-2xl border border-[var(--hairline)] sm:h-[248px]">
          {bannerImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bannerImage} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#1f2a20] via-[#1c1c1e] to-[#161616]" />
          )}
        </div>

        {/* Header row: avatar submerged into the banner (banner behind it), with a
            page-colored ring so it reads as a clean cutout, plus the actions. */}
        <div className="px-1">
          <div className="flex items-end justify-between">
            <div className="relative z-10 -mt-14 ml-4 h-28 w-28 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-surface)] ring-[6px] ring-[var(--color-bg-page)] sm:-mt-16 sm:ml-6 sm:h-32 sm:w-32">
              {avatarImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarImage} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                  <User size={44} weight="fill" />
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 pb-1">
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)]"
              >
                {shared ? (
                  <>
                    <Check size={14} weight="bold" className="text-[var(--color-accent-strong)]" /> Copied
                  </>
                ) : (
                  <>
                    <ShareNetwork size={14} weight="bold" /> Share
                  </>
                )}
              </button>
              {isOwn ? (
                <button
                  type="button"
                  onClick={() => setShowEdit(true)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-accent-solid)] px-3.5 text-[13px] font-semibold text-[var(--color-on-accent)] transition-opacity hover:opacity-90"
                >
                  <PencilSimple size={14} weight="bold" /> Edit profile
                </button>
              ) : (
                <>
                  <Link
                    href={`/messages?peer=${encodeURIComponent(address)}`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--color-bg-raised)] px-3 text-[13px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--hairline-strong)] hover:text-[var(--color-text-primary)]"
                  >
                    <ChatCircle size={14} weight="bold" /> Message
                  </Link>
                  <button
                    type="button"
                    onClick={handleFollow}
                    disabled={followBusy}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold transition-colors disabled:opacity-60 ${
                      graph?.viewerFollows
                        ? "border border-[var(--hairline-strong)] bg-transparent text-[var(--color-text-primary)] hover:border-[#a73520]/50 hover:text-[var(--color-negative)]"
                        : "bg-[var(--color-accent-solid)] text-[var(--color-on-accent)] hover:opacity-90"
                    }`}
                  >
                    <UserPlus size={14} weight="bold" /> {graph?.viewerFollows ? "Following" : "Follow"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Identity - inset to match the avatar so the name lines up under it */}
          <div className="mt-3 max-w-2xl pl-4 sm:pl-6">
            <div className="flex items-center gap-1.5">
              <h1 className="font-display text-[24px] font-semibold leading-tight tracking-tight text-[var(--color-text-primary)]">{displayName}</h1>
              {profile.verified && (
                <SealCheck size={22} weight="fill" className="shrink-0 text-[var(--color-accent-strong)]" aria-label="Verified" />
              )}
              {/* A token-<username> account is a reserved handle not yet bound to a
                  wallet — mark it Reserved. The tag drops once its owner binds a
                  wallet (the address becomes ansem1...). */}
              {!isOnchainAddress && (
                <span className="shrink-0 rounded-full border border-[#4a4327] bg-[#2a2616] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">
                  Reserved
                </span>
              )}
            </div>
            {/* When a username exists, the address sits next to it on one line;
                otherwise the address stands alone under the name. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {identity.showHandle && identity.handle && (
                <>
                  <span className="font-mono text-[13px] text-[var(--color-text-muted)]">{identity.handle}</span>
                  {isOnchainAddress && <span className="text-zinc-700">·</span>}
                </>
              )}
              {/* A token-<username> owner id is not a real address — hide it (and
                  its dangling separator) for reserved/token accounts. */}
              {isOnchainAddress && (
                <button
                  type="button"
                  onClick={copyAddress}
                  title={copied ? "Copied" : "Copy address"}
                  className="inline-flex items-center gap-1 font-mono text-[12px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                >
                  {handle}
                  {copied ? <Check size={12} weight="bold" className="text-[var(--color-accent-strong)]" /> : <CopySimple size={12} />}
                </button>
              )}
            </div>
            {profile.bio ? (
              <p className="mt-3 whitespace-pre-line text-[14px] leading-6 text-[var(--color-text-secondary)]">{profile.bio}</p>
            ) : isOwn ? (
              <button
                type="button"
                onClick={() => setShowEdit(true)}
                className="mt-3 inline-flex items-center gap-1 text-[13px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-accent-strong)]"
              >
                <PencilSimple size={13} weight="bold" /> Add a bio
              </button>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              {twitterLink && (
                <a href={externalUrl(twitterLink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                  <XLogo size={13} weight="fill" /> X
                </a>
              )}
              {telegramLink && (
                <a href={externalUrl(telegramLink)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                  <TelegramLogo size={13} weight="fill" /> Telegram
                </a>
              )}
              <button
                type="button"
                onClick={() => setFollowList("followers")}
                className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                <span className="font-semibold text-[var(--color-text-primary)]">{graph?.followerCount ?? 0}</span> followers
              </button>
              <button
                type="button"
                onClick={() => setFollowList("following")}
                className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                <span className="font-semibold text-[var(--color-text-primary)]">{graph?.followingCount ?? 0}</span> following
              </button>
              <button
                type="button"
                onClick={() => setTab("launches")}
                className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                <span className="font-semibold text-[var(--color-text-primary)]">{launches.length}</span> {launches.length === 1 ? "launch" : "launches"}
              </button>
            </div>
          </div>
        </div>

        {/* Content: tabs fill the main column, stats sit in a sidebar */}
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Tabs */}
        <div className="order-2 min-w-0 self-start rounded-2xl border border-[var(--hairline)] bg-[var(--color-bg-surface)] lg:order-1">
          <div className="flex items-center border-b border-[var(--hairline)] px-2">
            {(["posts", "launches", "holdings", "activity"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`relative -mb-px h-12 px-4 font-sans text-[14px] font-semibold capitalize transition-colors ${
                  tab === t ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                }`}
              >
                {t}
                {t === "launches" && launches.length > 0 && (
                  <span className="ml-1.5 font-mono text-[12px] text-[var(--color-text-subtle)]">{launches.length}</span>
                )}
                {tab === t && (
                  <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-[var(--color-accent-solid)]" />
                )}
              </button>
            ))}
          </div>

          <div className="p-4">
            {tab === "posts" && <ProfilePosts address={address} />}

            {tab === "launches" &&
              (launches.length ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {launches.map((t) => (
                    <TokenCard key={t.address} token={t} />
                  ))}
                </div>
              ) : (
                <Empty title="No coins launched yet" body="Coins this wallet creates on ANSEM will show here." />
              ))}

            {tab === "holdings" &&
              (holdings.isLoading ? (
                <Empty title="Loading holdings…" body="Reading token balances." />
              ) : holdings.data && holdings.data.length ? (
                <div className="divide-y divide-[var(--hairline)]">
                  {holdings.data.map((h) => (
                    <Link
                      key={h.mint}
                      href={`/token/${h.market}`}
                      className="group flex items-center gap-3 py-2.5"
                    >
                      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-[6px] border border-[var(--hairline)] bg-[var(--color-bg-raised)]">
                        {h.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={h.image} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full items-center justify-center text-xs text-[var(--color-text-subtle)]">
                            {h.symbol.slice(0, 1)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{h.name}</p>
                        <p className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">${h.symbol}</p>
                      </div>
                      <span className="mono text-[13px] font-semibold text-[var(--color-text-primary)]">
                        {compact(h.balance)}
                      </span>
                      <ArrowUpRight size={14} className="text-[var(--color-text-subtle)] transition-colors group-hover:text-[var(--color-accent-strong)]" />
                    </Link>
                  ))}
                </div>
              ) : (
                <Empty title="No coins held" body="Tokens bought by this wallet will appear here." />
              ))}

            {tab === "activity" && <ActivityFeed address={address} compact />}
          </div>
        </div>

        {/* Stats sidebar - borderless, separated by hairline dividers */}
        <aside className="order-1 self-start px-1 lg:order-2">
          <div className="divide-y divide-[var(--hairline)]">
            <StatCard
              label="PNL"
              value="-"
              foot="realized + unrealized, activates with position tracking"
            />
            <HoldingsCard
              ansem={nativeBalances.data?.ansem}
              chanse={nativeBalances.data?.chanse}
              loading={nativeBalances.isLoading}
              failed={nativeBalances.isError}
              coins={holdings.data?.length}
            />
            <StatCard
              label="Creator fees"
              value="-"
              foot="fees earned from your pools' Horns, activates when Horns wire in"
            />
          </div>
        </aside>
        </div>
      </div>

      {showEdit && (
        <ProfileEditModal
          address={address}
          initial={profile}
          onClose={() => setShowEdit(false)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["social", "profile", address] })}
        />
      )}

      {followList && (
        <FollowListModal
          tab={followList}
          followers={graph?.followers ?? []}
          following={graph?.following ?? []}
          onTab={setFollowList}
          onClose={() => setFollowList(null)}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="py-4">
      <p className="font-display text-[14px] font-semibold text-[var(--color-accent-strong)]">{label}</p>
      <p className="mono mt-1.5 text-[26px] font-bold tracking-tight text-[var(--color-text-primary)]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[var(--color-text-subtle)]">{foot}</p>
    </div>
  );
}

function HoldingsCard({
  ansem,
  chanse,
  loading,
  failed,
  coins,
}: {
  ansem?: number;
  chanse?: number;
  loading: boolean;
  failed: boolean;
  coins?: number;
}) {
  const fmt = (v?: number) => {
    if (loading) return "…";
    if (failed || v == null) return "-";
    return compact(v);
  };
  return (
    <div className="py-4">
      <p className="font-display text-[14px] font-semibold text-[var(--color-accent-strong)]">Holdings</p>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-semibold text-[var(--color-text-secondary)]">ANSEM</span>
          <span className="mono text-[20px] font-bold tracking-tight text-[var(--color-text-primary)]">{fmt(ansem)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-semibold text-[var(--color-text-secondary)]">CHANSE</span>
          <span className="mono text-[20px] font-bold tracking-tight text-[var(--color-text-primary)]">{fmt(chanse)}</span>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-text-subtle)]">
        native balances{coins != null ? ` · ${coins} ${coins === 1 ? "coin" : "coins"} held` : ""}
      </p>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-14 text-center">
      <p className="font-display text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</p>
      <p className="max-w-xs text-[12px] text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function shortHandle(addr: string): string {
  if (!addr) return "creator";
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
}

function externalUrl(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function compact(v: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v || 0);
}

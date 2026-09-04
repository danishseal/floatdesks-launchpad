"use client";

import {
  ExternalLink,
  Home,
  type LucideIcon,
  MessageCircle,
  PenLine,
  Search,
  Share2,
} from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import Comments from "@/components/Comments";
import SubscribeCard from "@/components/SubscribeCard";
import SearchModal from "@/components/SearchModal";

export default function BlogPage() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const [shared, setShared] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const identity = user?.email?.address
    ? user.email.address
    : user?.wallet?.address
      ? `${user.wallet.address.slice(0, 4)}..${user.wallet.address.slice(-4)}`
      : "Account";
  const onSignIn = () => {
    if (!ready) return;
    authenticated ? logout() : login();
  };
  const scrollToId = (id: string) =>
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  const onShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShared(true);
      setTimeout(() => setShared(false), 1500);
    } catch {}
  };
  return (
    <div className="min-h-screen bg-[#141111] text-white selection:bg-purple-500/30 font-sans">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 h-16 bg-transparent z-50 flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="relative hidden md:flex items-center gap-2 h-10 px-4 cursor-pointer text-sm group w-[240px]"
            style={{
              borderRadius: "calc(0.5rem + 8px)",
              color: "hsl(0 0% 80%)",
            }}
            aria-label="Search posts"
          >
            {/* Liquid Glass Visual Layers */}
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{
                borderRadius: "inherit",
                boxShadow:
                  "0 2px 4px rgba(0, 0, 0, 0.08), 0 0 8px rgba(0, 0, 0, 0.04)",
                transformOrigin: "50% 50%",
                transform: "scaleX(1.00003) scaleY(1.00019)",
              }}
            >
              {/* Glass Effect Layer with Backdrop Filter */}
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 0,
                  backdropFilter: "blur(1px) saturate(120%)",
                  WebkitBackdropFilter: "blur(1px) saturate(120%)",
                  isolation: "isolate",
                  borderRadius: "inherit",
                }}
              />
              {/* Tint Layer */}
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 1,
                  background: "#1c1817",
                  borderRadius: "inherit",
                }}
              />
              {/* Shine Layer */}
              <div
                className="absolute inset-0 overflow-hidden"
                style={{
                  zIndex: 2,
                  boxShadow:
                    "inset 0 0 0 1px hsl(30 8% 18% / 0.4), inset 1px 1px 0 0 rgba(255, 255, 255, 0.1)",
                  borderRadius: "inherit",
                }}
              />
            </div>

            {/* Content Layer */}
            <div
              className="relative flex items-center w-full h-full"
              style={{ zIndex: 3 }}
            >
              <Search className="h-4 w-4 shrink-0 mr-2" aria-hidden="true" />
              <span className="flex-1 text-left">Search...</span>
            </div>
          </button>
        </div>

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 opacity-70">
          <button
            type="button"
            className="relative flex items-center gap-2 px-4 py-2 cursor-pointer hover:text-white transition-colors"
            style={{
              borderRadius: "9999px",
              color: "hsl(0 0% 80%)",
            }}
          >
            {/* Liquid Glass Visual Layers */}
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{
                borderRadius: "inherit",
                boxShadow:
                  "0 2px 4px rgba(0, 0, 0, 0.08), 0 0 8px rgba(0, 0, 0, 0.04)",
                transformOrigin: "50% 50%",
                transform: "scaleX(1.00003) scaleY(1.00019)",
              }}
            >
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 0,
                  backdropFilter: "blur(1px) saturate(120%)",
                  WebkitBackdropFilter: "blur(1px) saturate(120%)",
                  isolation: "isolate",
                  borderRadius: "inherit",
                }}
              />
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 1,
                  background: "#1c1817",
                  borderRadius: "inherit",
                }}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{
                  zIndex: 2,
                  boxShadow:
                    "inset 0 0 0 1px hsl(30 8% 18% / 0.4), inset 1px 1px 0 0 rgba(255, 255, 255, 0.1)",
                  borderRadius: "inherit",
                }}
              />
            </div>

            {/* Content Layer */}
            <div className="relative" style={{ zIndex: 3 }}>
              <Image
                src="/commas-art-white.png"
                alt="commas.art"
                width={104}
                height={16}
                className="h-4 w-auto object-contain"
              />
            </div>
          </button>
        </div>

        <div className="flex items-center gap-4">
          {/* Sign In Button */}
          <button
            type="button"
            onClick={onSignIn}
            className="hidden sm:block relative text-sm font-medium hover:text-white transition-all duration-200 hover:-translate-y-0.5 active:scale-95 px-4 py-2"
            style={{
              borderRadius: "calc(0.5rem + 8px)",
              color: "hsl(0 0% 80%)",
            }}
          >
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{
                borderRadius: "inherit",
                boxShadow:
                  "0 2px 4px rgba(0, 0, 0, 0.08), 0 0 8px rgba(0, 0, 0, 0.04)",
                transformOrigin: "50% 50%",
                transform: "scaleX(1.00003) scaleY(1.00019)",
              }}
            >
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 0,
                  backdropFilter: "blur(1px) saturate(120%)",
                  WebkitBackdropFilter: "blur(1px) saturate(120%)",
                  isolation: "isolate",
                  borderRadius: "inherit",
                }}
              />
              <div
                className="absolute inset-0"
                style={{
                  zIndex: 1,
                  background: "#1c1817",
                  borderRadius: "inherit",
                }}
              />
              <div
                className="absolute inset-0 overflow-hidden"
                style={{
                  zIndex: 2,
                  boxShadow:
                    "inset 0 0 0 1px hsl(30 8% 18% / 0.4), inset 1px 1px 0 0 rgba(255, 255, 255, 0.1)",
                  borderRadius: "inherit",
                }}
              />
            </div>
            <span className="relative" style={{ zIndex: 3 }}>
              {authenticated ? identity : "Sign in"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => scrollToId("subscribe")}
            className="text-[#27261b] text-sm font-medium px-4 py-2 rounded-full transition-all duration-200 hover:-translate-y-0.5 active:scale-95 shadow-lg hover:opacity-90"
            style={{
              backgroundColor: "#3550bf",
              boxShadow: "0 10px 15px -3px rgba(59, 130, 246, 0.2)",
            }}
          >
            Subscribe
          </button>
        </div>
      </header>

      {/* Sidebar */}
      <aside className="fixed left-0 top-0 bottom-0 w-16 flex flex-col items-center justify-center gap-6 z-40 bg-[#141111]">
        <SidebarIcon icon={Home} />
        <SidebarIcon icon={Search} onClick={() => setSearchOpen((v) => !v)} />
        <SidebarIcon icon={PenLine} active />
      </aside>

      {/* Main Content */}
      <main className="pl-0 md:pl-16 pt-24 pb-4 w-full max-w-[1000px] mx-auto px-4 sm:px-8 md:px-12">
        {/* Hero Image */}
        <div className="w-full aspect-[2/1] bg-[#a881fc] rounded-2xl mb-12 relative overflow-hidden shadow-2xl shadow-purple-900/20 group">
          <Image
            src="/assets/blog-banner.avif"
            alt="The Last Supper, Panel I"
            fill
            className="object-cover"
            priority
          />
        </div>

        {/* Title Block */}
        <div className="mb-12 max-w-5xl mx-auto">
          <h1 className="text-3xl md:text-4xl lg:text-3xl font-bold mb-4 tracking-tight leading-[1.1] whitespace-nowrap overflow-hidden text-ellipsis sm:whitespace-normal">
            The Last Supper, Panel I: a token that owns a price
          </h1>
          <p className="text-xl text-zinc-400 font-light">
            Every commas token is launched against a real collectible market,
            and convertible into it.
          </p>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between mt-8 pb-8 gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center text-xs font-bold text-purple-200">
                ,
              </div>
              <div>
                <div className="font-medium text-white text-sm">commas</div>
                <div className="text-sm text-zinc-500">
                  5 min read · The Last Supper
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => scrollToId("comments")}
                className="inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-colors border border-zinc-800 text-white bg-[#1c1817] hover:bg-zinc-800 hover:text-white h-10 w-10"
                aria-label="Jump to comments"
              >
                <div className="relative">
                  <MessageCircle className="h-4 w-4" />
                </div>
              </button>
              <button
                type="button"
                onClick={onShare}
                className="flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-colors border border-zinc-800 text-white bg-[#1c1817] hover:bg-zinc-800 hover:text-white h-10 px-4 py-2 gap-2 sm:w-fit w-full"
                aria-label="Share this post"
              >
                <Share2 className="h-4 w-4" />
                <span>{shared ? "Copied" : "Share"}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Article Body */}
        <article className="prose prose-invert prose-lg max-w-3xl mx-auto text-zinc-300 leading-relaxed">
          <p className="mb-6">
            Every launchpad sells you the same thing: a ticker, a picture, and a
            prayer that attention holds. The token is backed by nothing because
            there is nothing behind it. When the crowd moves on, there is no
            floor under the floor.
          </p>

          <p className="mb-6">
            commas launches tokens differently. Every token is launched against a
            real collectible market: a PSA 10 graded card, or the floor of an NFT
            collection. Not inspired by it. Priced against it, with a live feed,
            and convertible into it.
          </p>

          <p className="mb-12">
            That last part is the whole story, so let us take it slowly.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            One token, one real thing
          </h2>

          <p className="mb-6">
            When someone launches a token on commas, they pick the underlying:
            say, a PSA 10 Umbreon VMAX. From that moment the token has a
            reference price that does not come from its own chart. It comes from
            the card&apos;s real market, the places where actual copies actually
            sell.
          </p>

          <blockquote className="border-l-2 border-[#3b82f6] pl-6 my-8 italic text-zinc-400">
            One million tokens represent one card. If the card is worth $2,100, a
            full unit of tokens is worth about $2,100 of exposure. The card
            doubles, your exposure doubles.
          </blockquote>

          <p className="mb-12">
            You never graded, shipped, insured, or vaulted anything. You just
            hold price exposure to a real thing.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            The launch is the boring part, on purpose
          </h2>

          <p className="mb-6">
            Launching works like every launchpad you already know, and that is
            deliberate. Every token starts at a 25 SOL market cap on a bonding
            curve. When the curve has raised 100 SOL, the market migrates
            automatically to an AMM, and the entire 100 SOL goes into the pool.
            No team allocation, no liquidity games: what was raised is what you
            trade against.
          </p>

          <p className="mb-12">
            Supply is fixed forever the moment the token is created. Nobody,
            including us, can ever mint more. Launching costs 0.1 SOL, takes
            about a minute, and the creator earns half of every trading fee the
            market ever generates. You can even route those fees to someone else:
            an X account, a YouTube channel, a forum legend who has no idea you
            exist. The fees wait in escrow until the real person claims them.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            The two doors
          </h2>

          <p className="mb-6">
            Here is where commas stops being a launchpad and becomes a market.
            Every market has two ways in and two ways out. The first is the SOL
            door: buy and sell with SOL, like any token, and these trades pay a
            0.70% fee.
          </p>

          <p className="mb-6">
            The second is the card door. If you hold a real, vaulted copy of the
            collectible, you can deposit it and receive tokens worth exactly what
            the card is worth. And it works in reverse: pay tokens worth one card,
            and walk away with an actual card from the pool.
          </p>

          <blockquote className="border-l-2 border-[#3b82f6] pl-6 my-8 italic text-zinc-400">
            The card door is completely free. No fee in either direction, on
            purpose: bringing the real thing into the market is the behavior we
            most want to reward.
          </blockquote>

          <p className="mb-12">
            The pool is not an abstraction. It holds real copies that real
            holders deposited, and any of them can be claimed by anyone willing
            to pay what a copy is worth.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            Why token buying moves the real card
          </h2>

          <p className="mb-6">
            This is the question everyone should ask. Say a wave of buying pushes
            the token above the card&apos;s real price. The token now trades
            rich, so tokens are worth more than the card they represent. That gap
            is free money for anyone holding a real copy: deposit the card,
            receive tokens worth more than the card, sell the difference.
          </p>

          <p className="mb-6">
            Where do those people get copies? The cheapest place possible: they
            buy the card&apos;s floor listings on the open market. Every copy
            they deposit gets locked in the pool, and every floor listing they
            bought is gone. Fewer copies for sale means a firmer, higher floor.
            The live price feed sees the higher floor and raises the token&apos;s
            reference price. The loop closes, one level up.
          </p>

          <p className="mb-12">
            Token demand literally consumes the collectible&apos;s cheapest
            supply. A memecoin pump buys nothing but its own chart. A commas pump
            buys the floor of a real market.
          </p>

          <p className="mb-12">
            And the reverse is softer than you would expect. If the token dumps
            below the card&apos;s value, the cheap exit is to buy tokens and
            redeem real cards from the pool, which supports the token on the way
            down. The pool can only release the copies it actually holds, so the
            downside is capped in a way the upside is not. It absorbs copies
            aggressively and gives them back reluctantly.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            For the people who already own the cards
          </h2>

          <p className="mb-6">
            If you hold the collectible, commas gives you two tools that never
            existed for cards before. You can sell without selling: deposit a
            copy when the token is rich, take the premium, and buy back later, so
            your collection becomes a yield instrument.
          </p>

          <p className="mb-12">
            Or you can hedge: lock SOL as collateral, draw tokens against it, and
            sell them to flatten your exposure without touching the physical
            card. When the token trades above the card&apos;s real price, the
            market literally pays hedgers to lean against it.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            What keeps it honest
          </h2>

          <p className="mb-12">
            Supply is fixed at creation and can only shrink; the mint is dead.
            The curve&apos;s terms cannot be edited after launch, ever. The price
            feed is smoothed, rate-limited, and wrapped in a circuit breaker: if
            a bad print deviates too far, the market freezes instead of moving.
            And swap pricing uses a time-averaged price, so a single-transaction
            sandwich cannot move the rate against you.
          </p>

          <hr className="my-8 border-white/[0.08]" />

          <h2 className="text-2xl font-bold text-white mt-12 mb-4">
            What is live, and what is next
          </h2>

          <p className="mb-6">
            The full protocol is live: launches, trading, the card door, hedging,
            and the price feeds, with the docs at{" "}
            <Link
              href="https://commas.art"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "#3b82f6" }}
            >
              commas.art
            </Link>{" "}
            covering every detail from a quickstart to the exact math.
          </p>

          <p className="mb-12">
            A commas token will launch on{" "}
            <Link
              href="https://pump.fun"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "#3b82f6" }}
            >
              pump.fun
            </Link>
            . The announcement and the official contract address will come from{" "}
            <Link
              href="https://x.com/commasdotart"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "#3b82f6" }}
            >
              @commasdotart
            </Link>{" "}
            and nowhere else. Three panels were minted on Solana mainnet to mark
            the start. This post was Panel I. The next one opens the economics
            all the way up.
          </p>

          <div className="flex flex-col items-center gap-8 mt-12 mb-20">
            <p className="text-lg font-medium text-white text-center">
              👉 Follow{" "}
              <span style={{ color: "#3b82f6" }}>@commasdotart</span> on X for
              the token announcement and the official contract address.
            </p>

            <Link
              href="https://launch.commas.art"
              target="_blank"
              rel="noreferrer"
              className="text-white font-medium px-6 py-3 rounded-xl transition-all duration-200 hover:opacity-90"
              style={{
                backgroundColor: "#3b82f6",
                boxShadow:
                  "0 0 18px rgba(59, 130, 246, 0.5), 0 8px 20px -6px rgba(59, 130, 246, 0.35)",
              }}
            >
              Launch on Commas
            </Link>
          </div>

          <div className="flex flex-col gap-4 max-w-2xl mx-auto w-full mb-8">
            {/* Subscribe Card */}
            <SubscribeCard />

            {/* Panel I Asset Card */}
            <div className="bg-[#1c1817] border border-zinc-800 rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="font-bold text-white">Panel I asset</h3>
                <p className="text-sm text-zinc-500 font-mono truncate">
                  7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="https://solscan.io/token/7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-medium border border-zinc-800 text-white bg-[#141111] hover:bg-zinc-800 rounded-xl px-4 h-10 transition-colors"
                >
                  Solscan
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
                <Link
                  href="https://core.metaplex.com/explorer/7iMMDFqAp2W5S4SiYKQWVC4QksDGvGRFQarzrpyZqA9N"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-medium border border-zinc-800 text-white bg-[#141111] hover:bg-zinc-800 rounded-xl px-4 h-10 transition-colors"
                >
                  Metaplex
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>

            {/* Comments Card */}
            <Comments />
          </div>
        </article>

        {/* Footer */}
        <footer className="mt-8 w-80 mx-auto flex flex-col justify-center pb-4">
          <nav
            aria-label="Discover commas content"
            className="text-xs text-center text-[#cccccc] my-4 flex flex-row flex-nowrap gap-4 justify-center"
          >
            <Link
              href="https://commas.art"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 hover:text-white transition-colors"
            >
              Home
            </Link>
            <Link
              href="https://launch.commas.art"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 hover:text-white transition-colors"
            >
              Launch
            </Link>
            <Link
              href="https://commas.art"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 hover:text-white transition-colors"
            >
              Docs
            </Link>
            <Link
              href="https://x.com/commasdotart"
              target="_blank"
              rel="noreferrer"
              className="shrink-0 hover:text-white transition-colors"
            >
              Twitter
            </Link>
          </nav>
        </footer>
      </main>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function SidebarIcon({
  icon: Icon,
  active,
  onClick,
}: {
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`p-3 rounded-xl transition-all relative group ${active ? "bg-[#e6ebfe] text-[#3e63f8] shadow-[0_0_15px_rgba(255,255,255,0.3)]" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"}`}
    >
      <Icon className="w-5 h-5" />
      {active && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-1 h-8 bg-white/0 rounded-l-full"></div>
      )}
    </button>
  );
}

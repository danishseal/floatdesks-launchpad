import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden text-white">
      {/* Sky gradient background */}
      <div
        className="absolute inset-0 -z-20"
        style={{
          background:
            "linear-gradient(180deg, #274a7d 0%, #3f628f 30%, #6f8cb0 62%, #b8c8dc 100%)",
        }}
      />
      {/* Soft haze near the horizon */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 120%, rgba(255,255,255,0.35), rgba(255,255,255,0) 60%)",
        }}
      />
      {/* Scanline / CRT texture */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-40 mix-blend-soft-light"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 2px, transparent 4px)",
        }}
      />

      {/* Top bar */}
      <header className="relative flex items-center justify-between px-6 md:px-10 pt-6">
        <Link href="/" className="shrink-0">
          <Image
            src="/commas-art-white.png"
            alt="commas.art"
            width={150}
            height={22}
            className="h-5 w-auto md:h-6"
            priority
          />
        </Link>
        <nav className="flex items-center gap-5 md:gap-7 text-sm md:text-base text-white/85">
          <Link
            href="https://commas.art"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            Docs
          </Link>
          <Link href="/blog" className="hover:text-white transition-colors">
            Journal
          </Link>
          <span className="hidden sm:block h-5 w-px bg-white/30" />
          <Link
            href="https://launch.commas.art"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 hover:text-white transition-colors"
          >
            Get started
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#3ddc4b] shadow-[0_0_10px_#3ddc4b]" />
          </Link>
        </nav>
      </header>
      <div className="relative mx-6 md:mx-10 mt-4 border-t border-white/25" />

      {/* Hero */}
      <section className="relative px-6 md:px-10 pt-8 md:pt-10">
        <h1 className="flex items-center gap-5 font-sans font-bold tracking-tight leading-[0.92] text-[15vw] md:text-[13vw] whitespace-nowrap text-white/90">
          <span className="inline-block rounded-full bg-white/85 w-[0.5em] h-[0.5em] shrink-0" />
          Backed by real collectibles
        </h1>
        <div className="mt-6 border-t border-white/25" />
      </section>

      {/* Bottom row */}
      <div className="absolute inset-x-0 bottom-0 px-6 md:px-10 pb-8 flex items-end justify-between gap-6">
        {/* Journal thumbnail */}
        <Link href="/blog" className="group shrink-0">
          <div className="w-20 md:w-24 aspect-[3/4] rounded-md overflow-hidden border border-white/40 shadow-lg">
            <Image
              src="/panel-thumb.jpg"
              alt="The Last Supper, Panel I"
              width={200}
              height={266}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          </div>
          <div className="mt-2 font-mono text-[11px] md:text-xs tracking-wider text-white/80 group-hover:text-white transition-colors">
            VISIT THE JOURNAL
          </div>
        </Link>

        {/* Mono statement */}
        <div className="hidden md:block max-w-xl font-mono text-xs leading-relaxed text-white/85 text-left">
          <p>V.01 ------------ COMMAS IS LIVE ------------ //</p>
          <p className="mt-2">
            EVERY TOKEN LAUNCHES AGAINST A REAL COLLECTIBLE MARKET. GRADED CARDS
            AND NFT FLOORS. NO VAULT, NO CUSTODY. PRICED AGAINST THE REAL THING,
            AND CONVERTIBLE INTO <span className="bg-white/20 px-1">IT.</span>
          </p>
        </div>
      </div>
    </main>
  );
}

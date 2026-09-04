"use client";

import { useEffect } from "react";

// Banner: the ANSEM "Bullpen" NFT art shown through the same holographic card
// wrapper the launchpad shipped with (the portable <pokemon-card> element:
// rounded card frame, 3D tilt on hover, foil shine + glare, drop shadow).
// We keep that wrapper and only swap the artwork to the bulls, size the cards
// to the hero, and neutralize the click-to-fullscreen so it stays a backdrop.

const BULLS = Array.from({ length: 15 }, (_, i) => `/bullpen/bull-${i + 1}.webp`);

// Repeat the set so the montage always fills the wide banner.
const TILES = [...BULLS, ...BULLS].slice(0, 21);

export function HeroBullFrame() {
  useEffect(() => {
    // Load the holo-card stylesheet + custom-element definition once.
    const CSS_ID = "pokemon-card-css";
    if (!document.getElementById(CSS_ID)) {
      const link = document.createElement("link");
      link.id = CSS_ID;
      link.rel = "stylesheet";
      link.href = "/pokemon-card/pokemon-card.css";
      document.head.appendChild(link);
    }
    const JS_ID = "pokemon-card-js";
    if (!customElements.get("pokemon-card") && !document.getElementById(JS_ID)) {
      // public asset, loaded at runtime (not bundled) so the element registers
      const script = document.createElement("script");
      script.id = JS_ID;
      script.type = "module";
      script.src = "/pokemon-card/pokemon-card.js";
      document.head.appendChild(script);
    }
  }, []);

  return (
    <div className="bull-hero absolute inset-0 flex flex-wrap content-center items-center justify-center gap-[1.4cqw] overflow-hidden p-[1.4cqw]">
      {/* Sizing + backdrop overrides for the holo wrapper, scoped to the hero. */}
      <style>{`
        .bull-hero { pointer-events: auto; }
        .bull-hero pokemon-card { width: 14.5cqw; }
        /* Keep hover tilt + shine, but never fling a card to the viewport. */
        .bull-hero pokemon-card.is-open .pcard-shell { transform: none !important; }
        .bull-hero pokemon-card.is-open .pcard-tilt { animation: none !important; }
      `}</style>
      {TILES.map((src, i) => (
        // @ts-expect-error - custom element registered at runtime
        <pokemon-card key={`${src}-${i}`} image={src} name={`ANSEM Bull #${(i % 15) + 1}`} />
      ))}
    </div>
  );
}

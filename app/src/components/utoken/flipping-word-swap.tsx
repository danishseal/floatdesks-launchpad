"use client";

import { cn } from "@/lib/utils";
import gsap from "gsap";
import Link from "next/link";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function segmentCharacters(text: string) {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

export interface FlippingWordSwapProps {
  /** The word or short phrase shown at rest. */
  word1: string;
  /** The word or short phrase revealed on interaction. */
  word2: string;
  /** Duration of each character flip in milliseconds. */
  duration?: number;
  /** Delay between neighboring character flips in milliseconds. */
  stagger?: number;
  /**
   * Where a click goes. With an href this renders an anchor, so the swap is
   * decoration on a real navigation rather than a button that has to
   * reimplement one; without it, a plain button.
   */
  href?: string;
  /**
   * The accessible name. The two words are decoration once they are flipping
   * mid-air, and a name that changes under the pointer is not one a screen
   * reader user can act on, so it is stated once here.
   */
  label?: string;
  /** Additional classes applied to the interactive container. */
  className?: string;
  /** Additional classes applied only to the revealed word. */
  toClassName?: string;
  /** Inline styles applied to the interactive container. */
  style?: CSSProperties;
  /** Inline styles applied only to the revealed word. */
  toStyle?: CSSProperties;
}

/**
 * One phrase flipping into another, a character at a time.
 *
 * Both words are laid on the same grid cell and rotated about opposite edges,
 * so the outgoing glyph falls away as the incoming one arrives and the line
 * never reflows. Reduced motion collapses the durations to zero rather than
 * removing the swap: the second word still appears, it just does not tumble.
 */
export function FlippingWordSwap({
  word1,
  word2,
  duration = 400,
  stagger = 44,
  href,
  label,
  className,
  toClassName,
  style,
  toStyle,
}: FlippingWordSwapProps) {
  const containerRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const swappedRef = useRef(false);
  const [isSwapped, setIsSwapped] = useState(false);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const resolvedDuration = prefersReducedMotion
      ? 0
      : Math.max(180, duration) / 1000;
    const resolvedStagger = prefersReducedMotion
      ? 0
      : Math.max(0, stagger) / 1000;

    const context = gsap.context(() => {
      const firstWord = gsap.utils.toArray<HTMLElement>(
        '[data-flip-word="first"]',
      );
      const secondWord = gsap.utils.toArray<HTMLElement>(
        '[data-flip-word="second"]',
      );

      gsap.set(firstWord, {
        rotationX: 0,
        opacity: 1,
        transformOrigin: "center top",
      });
      gsap.set(secondWord, {
        rotationX: -82,
        opacity: 0,
        transformOrigin: "center bottom",
      });

      const timeline = gsap.timeline({ paused: true });
      timeline
        .to(firstWord, {
          rotationX: 82,
          opacity: 0,
          duration: resolvedDuration,
          stagger: resolvedStagger,
          ease: "power2.in",
        })
        .to(
          secondWord,
          {
            rotationX: 0,
            opacity: 1,
            duration: resolvedDuration,
            stagger: resolvedStagger,
            ease: "power2.out",
          },
          `<${resolvedDuration * 0.62}`,
        );

      if (swappedRef.current) timeline.progress(1);
      timelineRef.current = timeline;
    }, containerRef);

    return () => {
      timelineRef.current = null;
      context.revert();
    };
  }, [duration, stagger, word1, word2]);

  const updateSwap = useCallback((next: boolean) => {
    swappedRef.current = next;
    setIsSwapped(next);

    if (next) {
      timelineRef.current?.play();
    } else {
      timelineRef.current?.reverse();
    }
  }, []);

  const renderCharacters = (text: string, layer: "first" | "second") =>
    segmentCharacters(text).map((character, index) => (
      <span
        key={`${layer}-${index}-${character}`}
        data-flip-word={layer}
        className="inline-block whitespace-pre [backface-visibility:hidden] [will-change:transform,opacity]"
      >
        {character === " " ? "\u00a0" : character}
      </span>
    ));

  const interaction = {
    onMouseEnter: () => updateSwap(true),
    onMouseLeave: () => updateSwap(false),
    onPointerUp: (event: React.PointerEvent) => {
      if (event.pointerType !== "mouse") updateSwap(!swappedRef.current);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) updateSwap(true);
    },
    onBlur: () => updateSwap(false),
  };

  const classes = cn(
    "relative inline-grid cursor-pointer select-none border-0 bg-transparent p-0 align-baseline font-[inherit] leading-[inherit] tracking-[inherit] text-[inherit]",
    "rounded-[0.08em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/30 focus-visible:ring-offset-2",
    className,
  );

  const words = (
    <span className="col-start-1 row-start-1 inline-grid overflow-hidden [perspective:800px]">
      <span
        className="col-start-1 row-start-1 inline-flex items-baseline justify-center gap-[0.012em] whitespace-pre"
        aria-hidden="true"
      >
        {renderCharacters(word1, "first")}
      </span>
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-baseline justify-center gap-[0.012em] whitespace-pre",
          toClassName,
        )}
        aria-hidden="true"
        style={toStyle}
      >
        {renderCharacters(word2, "second")}
      </span>
    </span>
  );

  if (href) {
    return (
      <Link
        ref={containerRef as React.Ref<HTMLAnchorElement>}
        href={href}
        aria-label={label ?? word1}
        className={classes}
        style={style}
        {...interaction}
      >
        {words}
      </Link>
    );
  }

  return (
    <button
      ref={containerRef as React.Ref<HTMLButtonElement>}
      type="button"
      className={classes}
      aria-label={label ?? (isSwapped ? word2 : word1)}
      aria-pressed={isSwapped}
      style={style}
      {...interaction}
    >
      {words}
    </button>
  );
}

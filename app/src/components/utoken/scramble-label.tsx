"use client";

import gsap from "gsap";
import { useMemo, useRef } from "react";

const characters = "abcdefghijklmnopqrstuvwxyz!@#$%^&*-_+=;:<>,";

type ElementRef = { current: HTMLElement | null };

// Literal port of module 96028 from float-web-main's mirrored Float site.
function scramble(
  ref: ElementRef,
  originalCharacters: string[],
  onComplete?: () => void,
  duration = 0.03,
  reverse = false,
) {
  if (!ref.current) return;

  const spans = ref.current.querySelectorAll("span");
  let completed = 0;

  spans.forEach((span, index) => {
    gsap.killTweensOf(span);
    let repeats = 0;
    const delay = reverse
      ? Math.pow(index + 1, 1.1) * (duration + 0.005)
      : (index + 1) * (duration + 0.04);

    gsap.fromTo(
      span,
      { opacity: 0 },
      {
        duration,
        repeatRefresh: true,
        repeatDelay: duration + 0.01,
        delay,
        innerHTML: () =>
          characters[Math.floor(Math.random() * characters.length)],
        opacity: 1,
        ease: "power2.out",
        onStart: () => {
          gsap.set(span, { "--opa": 1 });
        },
        onComplete: () => {
          gsap.set(span, {
            innerHTML: originalCharacters[index],
            delay: duration,
          });
          completed += 1;
          if (completed === spans.length && onComplete) onComplete();
        },
        repeat: 3,
        onRepeat: () => {
          repeats += 1;
          if (repeats === 1) gsap.set(span, { "--opa": 0 });
        },
      },
    );
  });
}

export function ScrambleLabel({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const splitCharacters = useMemo(
    () => (children ? children.split("") : []),
    [children],
  );

  if (!children) return null;

  return (
    <span
      ref={ref}
      className={`scramble-label hover-effect hover-effect--cursor-square ${className || ""}`}
      onMouseEnter={() => scramble(ref, splitCharacters)}
    >
      {splitCharacters.map((character, index) => (
        <span key={index}>{character}</span>
      ))}
    </span>
  );
}

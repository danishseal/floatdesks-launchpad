"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BufferAttribute, Color } from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";

const FLOAT_SAIL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAYAAAB5fY51AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAAAAAAAAPlDu38AAAAHdElNRQfqCQMNCCyWdypjAAADYklEQVR42u3d4UrDMABG0U58/1eeL7BBtbPJTc75L44hl/AZ2uMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAdPUZ/APqez+fzrz/7eDz8DXLa1+gPAHCWYAEZggVkCBaQYfDkX1wZ4u9g7G9ywgIyBAvIECwgQ7CAjO/RH4B93DF0vxr7DezrcMICMgQLyBAsIEOwgAxjJP9i1E13A/vanLCADMECMgQLyBAsIMNNd25jEOcqJywgQ7CADMECMgQLyDCCcpkXqXIXJywgQ7CADMECMgQLyDB48it3PDbGEM87TlhAhmABGYIFZAgWkGHc5K2zA/urkfzsC02v/A7244QFZAgWkCFYQIZgARme6c6vfHr8vjLEsx8nLCBDsIAMwQIyBAvIMLpzHMf8Q/fZm/OszQkLyBAsIEOwgAzBAjKM7rw1atR2+513nLCADMECMgQLyBAsIMPovqFVBmy33/fjhAVkCBaQIVhAhmABGQbKxY16Uekdg7iXsO7HCQvIECwgQ7CADMECMtx05ziOa7ffr4zaq9y65x5OWECGYAEZggVkCBaQ4QbwQma6+T3q0S8zfQd8nhMWkCFYQIZgARmCBWS46b643cZlL2FdmxMWkCFYQIZgARmCBWRsNciuZKYh+ezQPfsgvts/KIqcsIAMwQIyBAvIECwgw8gYUHxkyqjHy1z5fK/M9JlxwgJCBAvIECwgQ7CADINiwEy3wXdjdJ+LExaQIVhAhmABGYIFZBgUBzKmr8M4fw8nLCBDsIAMwQIyBAvI8CLVAIPuOP4xMhcnLCBDsIAMwQIyBAvIMOZOxrPGx/Hdz88JC8gQLCBDsIAMwQIyjIcBxuDP8502OWEBGYIFZAgWkCFYQIZBMcpjTz7PwD4/JywgQ7CADMECMgQLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApvYD2+yY/Gnb1qsAAAAASUVORK5CYII=";

const PRIMARY_LINKS = [
  { label: "Docs", href: "http://docs.floatdesks.com/" },
  { label: "Market", href: "https://floatdesks.com/market" },
  { label: "Top 200", href: "https://floatdesks.com/top200" },
  { label: "Launchpad", href: "https://app.floatdesks.com/" },
  { label: "Announcements", href: "https://floatdesks.com/announcements" },
  { label: "Liquidity Aggregator", href: "https://app.floatdesks.com/liquidity" },
] as const;

export function Footer() {
  return (
    <footer className="float-footer">
      <div className="float-footer__container">
        <Link className="float-footer__logo" href="/" aria-label="FLOAT - Home">
          {/* This is the exact sail mark used by the mirrored Float site. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={FLOAT_SAIL} width={300} height={300} alt="FLOAT Logo" />
        </Link>

        <div className="float-footer__bottom">
          <div className="float-footer__links">
            <FooterNavigation label="Site navigation" links={PRIMARY_LINKS} />
            <FooterNavigation
              label="Social media"
              links={[{ label: "Twitter", href: "https://x.com/floatdesks" }]}
            />
          </div>
          <div className="float-footer__copyright">© 2026 Float. All rights reserved</div>
        </div>
      </div>

      <FooterParticleField />
    </footer>
  );
}

function FooterNavigation({
  label,
  links,
}: {
  label: string;
  links: ReadonlyArray<{ label: string; href?: string }>;
}) {
  return (
    <nav className="float-footer__navigation" aria-label={label}>
      <ul>
        {links.map((link) => (
          <li key={link.label}>
            {link.href ? <a href={link.href}>{link.label}</a> : <span>{link.label}</span>}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FooterParticleField() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" || !document.hidden,
  );

  useEffect(() => {
    const onVisibilityChange = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsIntersecting(entry.isIntersecting),
      { threshold: 0.1 },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="float-footer__animation" aria-hidden="true">
      <FooterParticles isActive={isIntersecting && isDocumentVisible} />
    </div>
  );
}

function FooterParticles({ isActive = true }: { isActive?: boolean }) {
  return (
    <Canvas
      camera={{ fov: 75, near: 0.1, far: 1000, position: [0, 0, 6.45] }}
      dpr={isActive ? [1, 2] : 1}
      frameloop={isActive ? "demand" : "never"}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      linear
      flat
    >
      <ParticleGrid isActive={isActive} />
    </Canvas>
  );
}

function ParticleGrid({ isActive }: { isActive: boolean }) {
  const { size, invalidate } = useThree();
  const noiseGenerator = useRef(new ImprovedNoise());
  const colorOffset = useRef(0);
  const updateStride = useMemo(() => {
    if (typeof navigator === "undefined") return 1;
    return /Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg\//i.test(navigator.userAgent)
      ? 3
      : 1;
  }, []);
  const black = useMemo(() => new Color(0, 0, 0).convertLinearToSRGB(), []);
  const cream = useMemo(() => new Color("#f1eedb").convertLinearToSRGB(), []);
  const blue = useMemo(() => new Color("#2563eb").convertLinearToSRGB(), []);
  const sage = useMemo(() => new Color("#a6b4a3").convertLinearToSRGB(), []);

  const [positions, colors, xPositions, yPositions, pointCount] = useMemo(() => {
    const positions = new Float32Array(300_000);
    const colors = new Float32Array(300_000);
    const xPositions = new Float32Array(100_000);
    const yPositions = new Float32Array(100_000);
    let pointCount = 0;

    for (
      let x = (-32 * size.width) / size.height;
      x < (32 * size.width) / size.height && pointCount < 100_000;
      x += 1
    ) {
      for (let y = -32; y < 32 && pointCount < 100_000; y += 1) {
        const pointX = 0.16 * x;
        const pointY = 0.16 * y;
        positions[3 * pointCount] = pointX;
        positions[3 * pointCount + 1] = pointY;
        positions[3 * pointCount + 2] = 0;
        xPositions[pointCount] = pointX;
        yPositions[pointCount] = pointY;
        // Flow initializes the color attribute with random channel values before
        // the first noise-driven frame replaces them.
        // eslint-disable-next-line react-hooks/purity
        colors[3 * pointCount] = Math.random();
        // eslint-disable-next-line react-hooks/purity
        colors[3 * pointCount + 1] = Math.random();
        // eslint-disable-next-line react-hooks/purity
        colors[3 * pointCount + 2] = Math.random();
        pointCount += 1;
      }
    }

    return [positions, colors, xPositions, yPositions, pointCount] as const;
  }, [size.width, size.height]);

  const positionAttribute = useRef<BufferAttribute>(null);
  const colorAttribute = useRef<BufferAttribute>(null);

  useEffect(() => {
    if (positionAttribute.current && colorAttribute.current) {
      positionAttribute.current.needsUpdate = true;
      colorAttribute.current.needsUpdate = true;
    }
  }, [size.width, size.height]);

  useEffect(() => {
    if (!isActive) return;
    const interval = window.setInterval(() => invalidate(), 50);
    return () => window.clearInterval(interval);
  }, [invalidate, isActive]);

  useFrame((state) => {
    if (!isActive || !positionAttribute.current || !colorAttribute.current) return;

    const elapsedTime = state.clock.elapsedTime;
    const noiseTime = 0.1 * elapsedTime;
    const colorArray = colorAttribute.current.array;
    const start = colorOffset.current;

    for (let index = start; index < pointCount; index += updateStride) {
      const x = xPositions[index];
      const y = yPositions[index];
      const firstNoise = noiseGenerator.current.noise(x, y, noiseTime);
      const secondNoise = noiseGenerator.current.noise(y, x, noiseTime);
      const noise = noiseGenerator.current.noise(
        x * firstNoise * secondNoise * 0.1,
        y * firstNoise * secondNoise * 0.1,
        firstNoise,
      );
      const color =
        noise > 0
          ? noise > 0.15 && noise < 0.2
            ? cream
            : noise > 0.25 && noise < 0.3
              ? sage
              : black
          : noise > -0.2 && noise < -0.15
            ? blue
            : noise > -0.3 && noise < -0.25
              ? cream
              : black;
      const colorIndex = 3 * index;
      colorArray[colorIndex] = color.r;
      colorArray[colorIndex + 1] = color.g;
      colorArray[colorIndex + 2] = color.b;
    }

    colorOffset.current = (colorOffset.current + 1) % updateStride;
    colorAttribute.current.needsUpdate = true;
  });

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          ref={positionAttribute}
          attach="attributes-position"
          args={[positions, 3]}
          count={pointCount}
        />
        <bufferAttribute
          ref={colorAttribute}
          attach="attributes-color"
          args={[colors, 3]}
          count={pointCount}
        />
      </bufferGeometry>
      <pointsMaterial size={0.32} vertexColors />
    </points>
  );
}

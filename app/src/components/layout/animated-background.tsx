/**
 * Super-subtle animated backdrop: a few large, heavily-blurred green blobs that
 * drift very slowly. Sits behind all content (pointer-events off), low opacity,
 * and respects prefers-reduced-motion. Purely decorative.
 */
export function AnimatedBackground() {
  return (
    <div aria-hidden className="ansem-bg pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <span className="ansem-bg-blob ansem-bg-blob-1" />
      <span className="ansem-bg-blob ansem-bg-blob-2" />
      <span className="ansem-bg-blob ansem-bg-blob-3" />
    </div>
  );
}

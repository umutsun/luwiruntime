/**
 * The LUWI mark: an outer ring, an inner arch, and two inward curls.
 *
 * Drawn as strokes in `currentColor` rather than shipping the 2700px raster
 * the brand file wraps: the dashboard is loopback-only and its identity tile
 * is the one surface that keeps the same gradient and a white glyph in both
 * themes, so the mark inherits whatever colour the tile sets. This is the
 * product's own mark — `product-independence.test.ts` bans *vendor* names,
 * not LUWI itself.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="4.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="19.5" />
      <path d="M13.5 31v-8.5a10.5 10.5 0 0 1 21 0V31" />
      <path d="M21.4 21.5v7.6a3.4 3.4 0 1 1-6.8.4" />
      <path d="M26.6 21.5v7.6a3.4 3.4 0 1 0 6.8.4" />
    </svg>
  );
}

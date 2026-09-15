import clsx from "clsx";

const CANDLES = [
  { x: 11, wick: [25, 37], body: [28, 34] },
  { x: 19.5, wick: [18, 34], body: [21, 30] },
  { x: 28, wick: [11, 29], body: [14, 25] },
];

/**
 * The Market Terminal mark: rising candlesticks with a trend line breaking out upwards, on the brand gradient.
 * `animated` turns it into the loading indicator (candles breathe in sequence, the trend line redraws).
 */
export function BrandMark({ size = 36, animated = false, className, title }: { size?: number; animated?: boolean; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={clsx("shrink-0", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id="brand-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="55%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#0891b2" />
        </linearGradient>
        <linearGradient id="brand-trend" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#a7f3d0" />
          <stop offset="100%" stopColor="#fde68a" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="13" fill="url(#brand-tile)" />
      <rect x="1" y="1" width="46" height="23" rx="13" fill="#ffffff" opacity="0.08" />
      {CANDLES.map((c, i) => (
        <g key={c.x} className={animated ? "brand-bob" : undefined} style={animated ? { animationDelay: `${i * 140}ms` } : undefined}>
          <line x1={c.x + 2.25} x2={c.x + 2.25} y1={c.wick[0]} y2={c.wick[1]} stroke="#ffffff" strokeOpacity="0.75" strokeWidth="1.6" strokeLinecap="round" />
          <rect x={c.x} y={c.body[0]} width="4.5" height={c.body[1] - c.body[0]} rx="1.2" fill="#ffffff" />
        </g>
      ))}
      <path d="M8 36 L18 29 L25 31.5 L38.5 16" fill="none" stroke="url(#brand-trend)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
        pathLength={1} className={animated ? "brand-draw" : undefined} />
      <path d="M33.2 15.2 L39.4 15 L39.2 21.2" fill="none" stroke="#fde68a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

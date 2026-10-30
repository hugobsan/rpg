import type { CSSProperties } from "react";

/**
 * Placeholder com shimmer no formato do conteúdo (DESIGN.md).
 * <Skeleton w="60%" h={14} /> bloco · <Skeleton lines={3} /> parágrafo · <Skeleton circle w={32} h={32} />
 * Envolva a área que carrega em aria-busy="true".
 */
export default function Skeleton({ w, h, lines, circle, className = "", style }: {
  w?: number | string;
  h?: number | string;
  lines?: number;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  if (lines)
    return (
      <span className={`skeleton-lines ${className}`} style={{ width: w, ...style }} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="skeleton text" style={{ width: lines > 1 && i === lines - 1 ? "62%" : undefined }} />
        ))}
      </span>
    );
  return <span className={`skeleton${circle ? " circle" : ""} ${className}`} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

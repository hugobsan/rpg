import type { CSSProperties } from "react";

/**
 * Selo animado no acento do tema (anel de runas + arco + glifo do tema no centro). Não é spinner genérico.
 * <Loader label="O Mestre está narrando" showLabel /> · em botão: <Loader size={16} />
 */
export default function Loader({ size = 40, label = "Carregando", showLabel = false, className = "" }: {
  size?: number;
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span className={`loader ${className}`} role="status" style={{ "--loader-size": `${size}px` } as CSSProperties}>
      <span className="loader-seal">
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <circle className="loader-runes" cx="24" cy="24" r="21.5" pathLength="96" strokeDasharray="1 3" />
          <circle className="loader-arc" cx="24" cy="24" r="16.5" pathLength="100" strokeDasharray="28 72" />
          <circle className="loader-inner" cx="24" cy="24" r="12" />
        </svg>
        {size >= 28 && <span className="loader-glyph" aria-hidden="true" />}
      </span>
      {showLabel ? <span className="loader-label">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

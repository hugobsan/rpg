"use client";
import { useEffect } from "react";

export type ViewerItem = { src: string; caption?: string };

/** Tela cheia: Esc/clique fora/✕ fecham; ←/→ navegam quando há mais de uma imagem. */
export default function ImageViewer({
  items, index, onIndex, onClose,
}: { items: ViewerItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const go = (d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  const it = items[index];
  if (!it) return null;
  return (
    <div className="viewer" onClick={onClose}>
      <img src={it.src} alt={it.caption || "Imagem"} onClick={(e) => e.stopPropagation()} />
      <button className="viewer-btn viewer-close" aria-label="Fechar" onClick={onClose}>✕</button>
      {index > 0 && (
        <button className="viewer-btn viewer-prev" aria-label="Anterior"
          onClick={(e) => { e.stopPropagation(); go(-1); }}>←</button>
      )}
      {index < items.length - 1 && (
        <button className="viewer-btn viewer-next" aria-label="Próxima"
          onClick={(e) => { e.stopPropagation(); go(1); }}>→</button>
      )}
      {it.caption && <div className="viewer-caption" onClick={(e) => e.stopPropagation()}>{it.caption}</div>}
    </div>
  );
}

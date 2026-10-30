"use client";
import { useEffect, useRef, type SyntheticEvent } from "react";
import s from "./ImageViewer.module.css";

export type ViewerItem = { src: string; caption?: string };

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Tela cheia: Esc/clique fora/✕ fecham; ←/→ e deslizar o dedo navegam quando há mais de uma imagem. */
export default function ImageViewer({
  items, index, onIndex, onClose,
}: { items: ViewerItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const go = (d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); };
  const startX = useRef<number | null>(null);
  const swipedAt = useRef(0); // o clique logo depois de deslizar não fecha
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
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <div className={s.viewer} role="dialog" aria-modal="true" aria-label={it.caption || "Imagem"}
      onClick={() => Date.now() - swipedAt.current > 400 && onClose()}
      onPointerDown={(e) => { if (e.pointerType !== "mouse") startX.current = e.clientX; }}
      onPointerUp={(e) => {
        if (startX.current === null) return;
        const dx = e.clientX - startX.current;
        startX.current = null;
        if (Math.abs(dx) > 50) {
          swipedAt.current = Date.now();
          go(dx < 0 ? 1 : -1);
        }
      }}>
      <img key={it.src} className={s.img} src={it.src} alt={it.caption || "Imagem"} onClick={stop} />
      <button className={`${s.btn} ${s.close}`} aria-label="Fechar" onClick={onClose}><Icon d="M6 6l12 12M18 6 6 18" /></button>
      {index > 0 && (
        <button className={`${s.btn} ${s.prev}`} aria-label="Anterior" onClick={(e) => { stop(e); go(-1); }}><Icon d="m15 5-7 7 7 7" /></button>
      )}
      {index < items.length - 1 && (
        <button className={`${s.btn} ${s.next}`} aria-label="Próxima" onClick={(e) => { stop(e); go(1); }}><Icon d="m9 5 7 7-7 7" /></button>
      )}
      {(it.caption || items.length > 1) && (
        <div className={s.bar} onClick={stop}>
          {it.caption && <span>{it.caption}</span>}
          {items.length > 1 && <span className={s.count}>{index + 1} de {items.length}</span>}
        </div>
      )}
    </div>
  );
}

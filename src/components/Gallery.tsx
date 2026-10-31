"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import ImageViewer from "./ImageViewer";
import Skeleton from "./ui/Skeleton";
import s from "./Gallery.module.css";
import p from "./SidePanels.module.css";

type Img = { id: number; created_at: string; location: string | null; title: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const where = (i: Img) => i.location || i.title || "Cena sem local";

/** Miniatura: skeleton até a imagem carregar, depois aparece suave. */
function Thumb({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <Skeleton />}
      {/* miniatura redimensionada pelo Next (webp, ~15 KB em vez da imagem inteira); a tela cheia usa o original */}
      <Image src={src} alt={alt} fill sizes="(max-width: 600px) 45vw, 260px" className={loaded ? s.loaded : undefined}
        onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
    </>
  );
}

/** Galeria: recarrega ao abrir a aba (monta) e quando `refreshKey` muda (imagem nova). */
export default function Gallery({
  campaignId,
  refreshKey,
  onDeleted,
}: {
  campaignId: string;
  refreshKey: unknown;
  onDeleted?: () => void; // a imagem apagada pode ser a que está na ficha
}) {
  const [images, setImages] = useState<Img[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/images`)
      .then((r) => r.json())
      .then((d) => setImages(d.images || []))
      .catch(() => setImages([]));
  }, [campaignId, refreshKey]);

  // otimista: some na hora; se o DELETE falhar, volta para o mesmo lugar com o erro
  const remove = async (img: Img) => {
    setError("");
    setConfirming(null);
    const at = images?.findIndex((i) => i.id === img.id) ?? -1;
    setImages((list) => (list || []).filter((i) => i.id !== img.id));
    const res = await fetch(`/api/campaigns/${campaignId}/images/${img.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setImages((list) => {
        const next = [...(list || [])];
        next.splice(at < 0 ? next.length : Math.min(at, next.length), 0, img);
        return next;
      });
      setError((await res?.json().catch(() => ({})))?.error || "Falha ao apagar a imagem");
      return;
    }
    onDeleted?.();
  };

  if (!images)
    return (
      <div className={s.grid} aria-busy="true">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ aspectRatio: "4 / 3", borderRadius: "var(--r-md)" }} />)}
      </div>
    );
  if (!images.length)
    return (
      <div className={p.empty}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-8 8" />
        </svg>
        <b>Nenhuma imagem ainda</b>
        Use &quot;Ver ambiente&quot; na cena para o ilustrador pintar onde você está. Tudo que for pintado fica guardado aqui.
      </div>
    );
  const url = (i: Img) => `/api/campaigns/${campaignId}/images/${i.id}`;
  return (
    <>
      {error && <div className="error-box">{error}</div>}
      <div className={s.grid}>
        {images.map((i, n) => (
          <div key={i.id} className={s.item} style={{ animationDelay: `${Math.min(n, 8) * 30}ms` }}>
            <button className={s.open} onClick={() => setOpen(n)} aria-label={`Abrir ${where(i)}`}>
              <Thumb src={url(i)} alt={where(i)} />
              <span className={s.cap}>
                <span className={s.where}>{where(i)}</span>
                <span className={s.when}>{when(i.created_at)}</span>
              </span>
            </button>
            {confirming === i.id ? (
              <div className={s.confirm}>
                <span>Apagar esta imagem?</span>
                <div>
                  <button className="btn danger small" onClick={() => remove(i)}>Apagar</button>
                  <button className="btn ghost small" onClick={() => setConfirming(null)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <button className={s.del} title="Apagar imagem" aria-label="Apagar imagem" onClick={() => setConfirming(i.id)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
      {open !== null && images[open] && (
        <ImageViewer
          items={images.map((i) => ({ src: url(i), caption: `${where(i)} · ${when(i.created_at)}` }))}
          index={open} onIndex={setOpen} onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

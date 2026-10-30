"use client";
import { useEffect, useState } from "react";
import ImageViewer from "./ImageViewer";

type Img = { id: number; created_at: string; location: string | null; title: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const where = (i: Img) => i.location || i.title || "Cena sem local";

/** Galeria: recarrega ao abrir a aba (monta) e quando `refreshKey` muda (imagem nova). */
export default function Gallery({ campaignId, refreshKey }: { campaignId: string; refreshKey: unknown }) {
  const [images, setImages] = useState<Img[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/images`)
      .then((r) => r.json())
      .then((d) => setImages(d.images || []))
      .catch(() => setImages([]));
  }, [campaignId, refreshKey]);
  if (!images) return <p className="muted">Carregando...</p>;
  if (!images.length) return <p className="muted">Nenhuma imagem ainda. Use "Ver ambiente".</p>;
  const url = (i: Img) => `/api/campaigns/${campaignId}/images/${i.id}`;
  return (
    <>
      <div className="gallery">
        {images.map((i, n) => (
          <button key={i.id} className="gallery-item" onClick={() => setOpen(n)}>
            <img src={url(i)} alt={where(i)} loading="lazy" />
            <span className="when">{when(i.created_at)}</span>
            <span className="where">{where(i)}</span>
          </button>
        ))}
      </div>
      {open !== null && (
        <ImageViewer
          items={images.map((i) => ({ src: url(i), caption: `${where(i)} · ${when(i.created_at)}` }))}
          index={open} onIndex={setOpen} onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

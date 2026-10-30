"use client";
import { useEffect, useState } from "react";
import ImageViewer from "./ImageViewer";

type Img = { id: number; created_at: string; location: string | null; title: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const where = (i: Img) => i.location || i.title || "Cena sem local";

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

  const remove = async (img: Img) => {
    setError("");
    const res = await fetch(`/api/campaigns/${campaignId}/images/${img.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Falha ao apagar a imagem");
      return;
    }
    setConfirming(null);
    setImages((list) => (list || []).filter((i) => i.id !== img.id));
    onDeleted?.();
  };

  if (!images) return <p className="muted">Carregando...</p>;
  if (!images.length) return <p className="muted">Nenhuma imagem ainda. Use "Ver ambiente".</p>;
  const url = (i: Img) => `/api/campaigns/${campaignId}/images/${i.id}`;
  return (
    <>
      {error && <div className="error-box" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="gallery">
        {images.map((i, n) => (
          <div key={i.id} className="gallery-item">
            <button className="gallery-open" onClick={() => setOpen(n)}>
              <img src={url(i)} alt={where(i)} loading="lazy" />
              <span className="when">{when(i.created_at)}</span>
              <span className="where">{where(i)}</span>
            </button>
            {confirming === i.id ? (
              <div className="gallery-confirm">
                <span>Apagar esta imagem?</span>
                <button className="btn small" onClick={() => remove(i)}>Apagar</button>
                <button className="btn ghost small" onClick={() => setConfirming(null)}>Cancelar</button>
              </div>
            ) : (
              <button className="gallery-delete" title="Apagar imagem" aria-label="Apagar imagem"
                onClick={() => setConfirming(i.id)}>🗑</button>
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

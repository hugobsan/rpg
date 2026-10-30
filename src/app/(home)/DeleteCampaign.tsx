"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import s from "./home.module.css";

/** Botão de excluir no cartão, com confirmação no próprio cartão (sem confirm()). */
export default function DeleteCampaign({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
  }, [asking]);

  const del = async () => {
    setBusy(true);
    const res = await fetch(`/api/campaigns/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setBusy(false);
      toast("Não foi possível excluir a campanha. Tente de novo.", { kind: "alerta" });
      return;
    }
    toast(`"${name}" foi excluída.`, { kind: "sucesso" });
    router.refresh();
  };

  return (
    <>
      <div className={s.actions}>
        <button className={`btn ghost small ${s.iconBtn}`} aria-label={`Excluir a campanha ${name}`} title="Excluir campanha" onClick={() => setAsking(true)}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9M6.8 7v4.5M9.2 7v4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {asking && (
        <div className={s.confirm} role="alertdialog" aria-label={`Excluir ${name}`}
          onKeyDown={(e) => e.key === "Escape" && !busy && setAsking(false)}>
          <p><b>Excluir &quot;{name}&quot;?</b></p>
          <p className="muted">Personagem, NPCs, histórico, memórias e imagens somem junto. Não dá para desfazer.</p>
          <div className={s.row}>
            <button ref={cancelRef} className="btn ghost small" disabled={busy} onClick={() => setAsking(false)}>Cancelar</button>
            <button className="btn danger small" disabled={busy} onClick={del}>
              {busy ? <Loader size={14} label="Excluindo" /> : null}
              Excluir de vez
            </button>
          </div>
        </div>
      )}
    </>
  );
}

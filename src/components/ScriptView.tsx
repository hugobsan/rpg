"use client";
import { useEffect, useState } from "react";
import Loader from "./ui/Loader";
import s from "./SidePanels.module.css";

const Down = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

interface View {
  arc: { title: string; stakes: string } | null;
  clocks: { name: string; filled: number; segments: number }[];
}

/** Aba Roteiro: só o título e o que está em jogo do arco ativo e os relógios. Os beats nunca vêm (spoiler). */
export default function ScriptView({ campaignId, onChange }: { campaignId: string; onChange: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/script`).then((r) => r.json()).then(setView).catch(() => setView({ arc: null, clocks: [] }));
  }, [campaignId]);
  const redo = async () => {
    setConfirming(false);
    setBusy(true);
    const r = await fetch(`/api/campaigns/${campaignId}/script`, { method: "POST" });
    if (r.ok) setView(await r.json());
    setBusy(false);
    onChange();
  };
  return (
    <div className={s.wrap}>
      <details className={s.how}>
        <summary>Para que serve o roteiro</summary>
        <p>
          O Roteirista planeja o que o <b>mundo</b> faz neste arco, com prazos: se você não estiver lá, acontece fora de cena e
          vira notícia. Os relógios enchem com o tempo e com as cenas. Antes de cada cena, o Diretor escolhe o que ela quer e
          o Narrador conta. O plano em si fica escondido para não estragar a surpresa.
        </p>
      </details>

      {busy || !view ? (
        <div className={s.gate} aria-busy="true">
          <Loader size={34} label={busy ? "O Roteirista está escrevendo" : "Carregando"} showLabel />
          {busy && <p>Montando o arco. Leva um minuto.</p>}
        </div>
      ) : !view.arc ? (
        <div className={s.empty}>
          <b>Ainda sem arco</b>
          O Roteirista escreve o primeiro arco ao criar a campanha ou depois do primeiro turno.
          <button className="btn small" style={{ marginTop: 6 }} onClick={redo}>Gerar arco</button>
        </div>
      ) : (
        <>
          <div className={s.head}>
            <h4>{view.arc.title}</h4>
          </div>
          <p className={s.premise}>{view.arc.stakes}</p>
          {view.clocks.map((c) => (
            <div key={c.name} className={s.sub} title={`${c.filled} de ${c.segments}`}>
              <div>{c.name}</div>
              <div style={{ display: "flex", gap: 3, marginTop: 4 }} aria-label={`${c.filled} de ${c.segments}`}>
                {Array.from({ length: c.segments }, (_, i) => (
                  <span key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: i < c.filled ? "var(--accent)" : "color-mix(in srgb, currentColor 18%, transparent)" }} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {view?.arc && !busy && (
        confirming ? (
          <div className={s.actions}>
            <span className={s.sub}>O arco atual é refeito do ponto em que a história está; o que já aconteceu fica.</span>
            <button className="btn danger small" onClick={redo}>Refazer</button>
            <button className="btn ghost small" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        ) : (
          <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setConfirming(true)}>Refazer arco</button>
        )
      )}
      <div className={s.links}>
        <a className="btn ghost small" href={`/api/campaigns/${campaignId}/export?what=ruleset`}><Down /> Mecânica (JSON)</a>
        <a className="btn ghost small" href={`/api/campaigns/${campaignId}/export?what=full`}><Down /> Campanha inteira</a>
      </div>
    </div>
  );
}

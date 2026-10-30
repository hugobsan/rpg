"use client";
import { useState } from "react";
import type { CampaignScript } from "@/lib/types";
import Loader from "./ui/Loader";
import s from "./SidePanels.module.css";

const STATUS: Record<string, string> = { active: "em andamento", done: "concluído", pending: "pendente" };
const Anchor = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="5" r="2" /><path d="M12 7v14M5 13a7 7 0 0 0 14 0M8 11h8" />
  </svg>
);
const Pen = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 5 4 4L8 20H4v-4L15 5Z" />
  </svg>
);
const Down = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

export default function ScriptView({
  script,
  campaignId,
  onChange,
}: {
  script: CampaignScript | null;
  campaignId: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [show, setShow] = useState(false);
  const regen = async () => {
    setConfirming(false);
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/script`, { method: "POST" });
    setBusy(false);
    onChange();
  };
  return (
    <div className={s.wrap}>
      <details className={s.how}>
        <summary>Para que serve o roteiro</summary>
        <p>
          É o planejamento interno do Mestre, feito pelo agente Roteirista a partir do seu personagem e do ponto de partida.
          Ele divide a história em <b>arcos</b> e, em cenários baseados numa obra, ancora cada arco nos <b>eventos canônicos</b> daquele
          momento, além de plantar ganchos ligados ao seu passado e aos seus objetivos.
        </p>
        <p>
          Durante o jogo o Mestre consulta o roteiro para saber em que ponto está e anota o progresso. É um guia, não um trilho: suas
          escolhas podem desviar a história, e o Mestre adapta. Regenerar cria um plano novo e descarta as anotações.
        </p>
      </details>

      {busy ? (
        <div className={s.gate} aria-busy="true">
          <Loader size={34} label="O Roteirista está escrevendo" showLabel />
          <p>Montando arcos e ganchos. Leva um minuto.</p>
        </div>
      ) : !script ? (
        <div className={s.empty}>
          <b>Ainda sem roteiro</b>
          Gere um para o Mestre ter um plano de arcos e saber para onde levar a história.
          <button className="btn small" style={{ marginTop: 6 }} onClick={regen}>Gerar roteiro</button>
        </div>
      ) : !show ? (
        <div className={s.gate}>
          <b>{script.arcs.length} arcos planejados</b>
          <p>O roteiro revela o que o Mestre planejou. Abra só se não se importar com spoilers.</p>
          <button className="btn ghost small" onClick={() => setShow(true)}>Mostrar o roteiro</button>
        </div>
      ) : (
        <>
          <div className={s.head}>
            <h4>Roteiro</h4>
            <button className="btn ghost small" onClick={() => setShow(false)}>Esconder</button>
          </div>
          <p className={s.premise}>{script.premise}</p>
          <ol className={s.arcs}>
            {script.arcs.map((a, i) => (
              <li key={i} className={`${s.arc}${a.status === "done" ? ` ${s.done}` : a.status === "active" ? ` ${s.active}` : ""}`}>
                <span className={s.arcDot} aria-hidden="true">
                  {a.status === "done" ? (
                    <svg viewBox="0 0 12 12" width="10" height="10"><path d="m2.5 6.5 2.2 2L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  ) : <span className="num" style={{ fontSize: 10, fontWeight: 600 }}>{i + 1}</span>}
                </span>
                <div className={s.title}>
                  {a.title} <span className={s.chip}>{STATUS[a.status] || a.status}</span>
                </div>
                <div className={s.sub}>{a.summary}</div>
                {a.canonEvents.length > 0 && <div className={s.arcMeta}><Anchor /><span>{a.canonEvents.join(" · ")}</span></div>}
                {a.notes.length > 0 && <div className={s.arcMeta}><Pen /><span>{a.notes.slice(-3).join(" · ")}</span></div>}
              </li>
            ))}
          </ol>
        </>
      )}

      {script && !busy && (
        confirming ? (
          <div className={s.actions}>
            <span className={s.sub}>Regenerar descarta o roteiro atual, inclusive as anotações de progresso.</span>
            <button className="btn danger small" onClick={regen}>Regenerar</button>
            <button className="btn ghost small" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        ) : (
          <button className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setConfirming(true)}>Regenerar roteiro</button>
        )
      )}
      <div className={s.links}>
        <a className="btn ghost small" href={`/api/campaigns/${campaignId}/export?what=ruleset`}><Down /> Mecânica (JSON)</a>
        <a className="btn ghost small" href={`/api/campaigns/${campaignId}/export?what=full`}><Down /> Campanha inteira</a>
      </div>
    </div>
  );
}

"use client";
import { useState } from "react";
import type { CampaignScript } from "@/lib/types";

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
  const regen = async () => {
    if (script && !confirm("Regenerar o roteiro descarta o atual (notas de progresso inclusas). Continuar?")) return;
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/script`, { method: "POST" });
    setBusy(false);
    onChange();
  };
  const STATUS: Record<string, string> = { active: "▶ ativo", done: "✓ concluído", pending: "· pendente" };
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="ability-item" style={{ marginBottom: 12 }}>
        <div className="name">Para que serve o roteiro</div>
        <div className="sub" style={{ lineHeight: 1.5 }}>
          É o planejamento interno do Mestre, feito pelo agente Roteirista a partir do seu personagem e do ponto
          de partida da campanha. Ele divide a história em <b>arcos</b> e, em cenários baseados numa obra, ancora
          cada arco nos <b>eventos canônicos</b> daquele momento da linha do tempo (⚓), além de plantar ganchos
          ligados ao seu passado e aos seus objetivos.
          <br /><br />
          Durante o jogo o Mestre consulta o roteiro para saber em que ponto da história está e anota o progresso
          (✎), marcando arcos como ativos ou concluídos. Ele é um guia, não um trilho: suas escolhas podem desviar
          a história, e o Mestre adapta. Regenerar cria um plano novo e descarta as anotações de progresso.
        </div>
      </div>
      {!script && <p className="muted">Esta campanha ainda não tem roteiro. Gere um para o Mestre ter um plano de arcos.</p>}
      {script && !show && (
        <button className="btn ghost small" onClick={() => setShow(true)}>
          👁 Mostrar o roteiro (contém spoilers do que o Mestre planejou)
        </button>
      )}
      {script && show && (
        <>
          <button className="btn ghost small" onClick={() => setShow(false)} style={{ marginBottom: 8 }}>Esconder roteiro</button>
          <p style={{ fontSize: 13, fontStyle: "italic" }}>{script.premise}</p>
          {script.arcs.map((a, i) => (
            <div key={i} className="ability-item" style={{ opacity: a.status === "done" ? 0.55 : 1 }}>
              <div className="name">
                {a.title} <span className="pill">{STATUS[a.status] || a.status}</span>
              </div>
              <div className="sub">{a.summary}</div>
              {a.canonEvents.length > 0 && (
                <div className="sub" style={{ marginTop: 4 }}>⚓ {a.canonEvents.join(" · ")}</div>
              )}
              {a.notes.length > 0 && (
                <div className="sub" style={{ marginTop: 4 }}>✎ {a.notes.slice(-3).join(" · ")}</div>
              )}
            </div>
          ))}
        </>
      )}
      <button className="btn ghost small" onClick={regen} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? "gerando..." : script ? "Regenerar roteiro" : "Gerar roteiro"}
      </button>
      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <a className="btn ghost small" style={{ whiteSpace: "nowrap", textDecoration: "none" }} href={`/api/campaigns/${campaignId}/export?what=ruleset`}>⬇ Exportar mecânica (JSON)</a>
        <a className="btn ghost small" style={{ whiteSpace: "nowrap", textDecoration: "none" }} href={`/api/campaigns/${campaignId}/export?what=full`}>⬇ Exportar campanha</a>
      </div>
    </div>
  );
}

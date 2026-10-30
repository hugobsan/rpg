"use client";
import { formatClock, getClock } from "@/lib/clock";
import { formatRemaining, getObjectives, Objective, OBJECTIVE_KIND_LABEL } from "@/lib/objectives";

const STATUS_LABEL = { concluido: "✅ concluído", perdido: "⌛ perdido", cancelado: "✖ cancelado", aberto: "aberto" };

/** Aba "Missões": missões, eventos e prazos que o Mestre registra conforme a história. */
export default function ObjectivesView({ state }: { state: Record<string, unknown> }) {
  const now = getClock(state)?.minutes;
  const all = getObjectives(state);
  // prazo mais próximo primeiro; sem prazo no fim
  const open = all
    .filter((o) => o.status === "aberto")
    .sort((a, b) => (a.deadlineMinutes ?? Infinity) - (b.deadlineMinutes ?? Infinity));
  const closed = all.filter((o) => o.status !== "aberto").reverse();

  const item = (o: Objective) => {
    const left = o.deadlineMinutes !== undefined && now !== undefined ? o.deadlineMinutes - now : null;
    const color =
      o.status !== "aberto" || left === null ? undefined : left < 6 * 60 ? "var(--danger)" : left < 24 * 60 ? "var(--mode-training)" : undefined;
    return (
      <div key={o.id} className="ability-item" style={color ? { borderColor: color } : undefined}>
        <div className="name">
          {o.title} <span className="pill">{OBJECTIVE_KIND_LABEL[o.kind] || o.kind}</span>
          {o.status !== "aberto" && <span className={`pill${o.status === "concluido" ? " on" : o.status === "perdido" ? " err" : ""}`}>{STATUS_LABEL[o.status]}</span>}
        </div>
        {o.description && <div className="sub" style={{ marginTop: 4 }}>{o.description}</div>}
        {o.reward && <div className="sub"><b>Recompensa:</b> {o.reward}</div>}
        <div className="sub" style={{ marginTop: 4, color }}>
          {o.deadlineMinutes === undefined
            ? "sem prazo"
            : `prazo: ${formatClock(o.deadlineMinutes)}${o.status === "aberto" && left !== null ? ` · ${formatRemaining(left)}` : ""}`}
        </div>
      </div>
    );
  };

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Missões, eventos marcados e outros compromissos da história. O Mestre registra quando surgem e marca quando são cumpridos.
        Prazos correm no tempo do jogo: treinar, viajar ou descansar demais faz o prazo passar, e a missão é perdida.
      </p>
      {!open.length && <p className="muted">Nada em aberto agora.</p>}
      {open.map(item)}
      {closed.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Encerrados ({closed.length})</summary>
          <div style={{ marginTop: 6, opacity: 0.8 }}>{closed.map(item)}</div>
        </details>
      )}
    </div>
  );
}

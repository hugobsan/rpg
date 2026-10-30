"use client";
import { formatClock, getClock } from "@/lib/clock";
import { formatRemaining, getObjectives, Objective, OBJECTIVE_KIND_LABEL } from "@/lib/objectives";
import s from "./SidePanels.module.css";

const STATUS_LABEL = { concluido: "concluído", perdido: "perdido", cancelado: "cancelado", aberto: "aberto" };

const FlagIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" />
  </svg>
);
const StarIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
    <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3Z" />
  </svg>
);

/** Urgência pelo tempo que falta: menos de 6 h é perigo, menos de 24 h é alerta. */
const urgency = (left: number | null) => (left === null ? "" : left < 6 * 60 ? "danger" : left < 24 * 60 ? "warn" : "");

/** Aba "Missões": missões, eventos e prazos que o Mestre registra conforme a história. */
export default function ObjectivesView({ state }: { state: Record<string, unknown> }) {
  const now = getClock(state)?.minutes;
  const all = getObjectives(state);
  // prazo mais próximo primeiro; sem prazo no fim
  const open = all
    .filter((o) => o.status === "aberto")
    .sort((a, b) => (a.deadlineMinutes ?? Infinity) - (b.deadlineMinutes ?? Infinity));
  const closed = all.filter((o) => o.status !== "aberto").reverse();

  const item = (o: Objective, n: number) => {
    const isOpen = o.status === "aberto";
    const left = isOpen && o.deadlineMinutes !== undefined && now !== undefined ? o.deadlineMinutes - now : null;
    const u = urgency(left);
    // quanto do prazo já passou, desde que a missão surgiu
    const span = o.deadlineMinutes !== undefined ? o.deadlineMinutes - o.createdAt : 0;
    const used = left !== null && span > 0 ? Math.max(0, Math.min(1, 1 - left / span)) : null;
    return (
      <div key={o.id} className={`${s.card} ${s.quest}${u ? ` ${s[u]}` : ""}${isOpen ? "" : ` ${s.closed}`}`}
        style={{ animationDelay: `${Math.min(n, 8) * 25}ms` }}>
        <div className={s.row} style={{ alignItems: "flex-start" }}>
          <div className={s.grow}>
            <div className={s.title}>{o.title}</div>
          </div>
          {isOpen ? (
            <span className={s.chip}>{OBJECTIVE_KIND_LABEL[o.kind] || o.kind}</span>
          ) : (
            <span className={`${s.chip} ${o.status === "concluido" ? s.ok : o.status === "perdido" ? s.bad : ""}`}>{STATUS_LABEL[o.status]}</span>
          )}
        </div>
        {o.description && <div className={s.sub}>{o.description}</div>}
        {o.reward && <span className={s.reward}><StarIcon /> {o.reward}</span>}
        {isOpen && (
          <>
            <div className={s.deadline}>
              <span>{o.deadlineMinutes === undefined ? "sem prazo" : `até ${formatClock(o.deadlineMinutes)}`}</span>
              {left !== null && <span className={s.left}>{formatRemaining(left)}</span>}
            </div>
            {used !== null && <div className={s.timebar}><span style={{ transform: `scaleX(${used})` }} /></div>}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={s.wrap}>
      <details className={s.how}>
        <summary>Como funcionam os prazos</summary>
        <p>
          O Mestre registra missões, eventos marcados e compromissos quando surgem na história e marca quando são cumpridos.
          Prazos correm no tempo do jogo: treinar, viajar ou descansar demais faz o prazo passar, e a missão é perdida.
        </p>
      </details>
      {!open.length ? (
        <div className={s.empty}>
          <FlagIcon size={26} />
          <b>Nada em aberto agora</b>
          Quando alguém te der uma missão ou marcar um encontro, ela aparece aqui com o tempo que falta.
        </div>
      ) : (
        <>
          <div className={s.head}><h4>Em aberto</h4><span className={s.count}>{open.length}</span></div>
          {open.map(item)}
        </>
      )}
      {closed.length > 0 && (
        <details className={s.more}>
          <summary>Encerradas ({closed.length})</summary>
          <div>{closed.map(item)}</div>
        </details>
      )}
    </div>
  );
}

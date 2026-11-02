"use client";
import { formatClock, getClock } from "@/lib/clock";
import { formatRemaining, getObjectives, Objective, OBJECTIVE_KIND_LABEL, objectiveXp } from "@/lib/objectives";
import { getTable } from "@/lib/table";
import type { Ruleset } from "@/lib/types";
import { formatMoney } from "@/lib/money";
import s from "./SidePanels.module.css";

const STATUS_LABEL = { concluido: "concluído", perdido: "perdido", cancelado: "cancelado", aberto: "aberto", oferecida: "oferecida" };
const SIZE_LABEL = { pequena: "missão pequena", media: "missão média", grande: "missão grande", excepcional: "feito excepcional" };

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

type Decide = (o: Objective, accept: boolean) => void;
// correção do registro: aberto, concluído ou cancelado (perdida que foi cumprida vira concluída)
type Fix = (o: Objective, status: "aberto" | "concluido" | "cancelado") => void;

/** Oferecida com o prazo já vencido: não dá para aceitar (o update_objective também recusa). */
const isLate = (o: Objective, now: number | undefined) => o.deadlineMinutes !== undefined && now !== undefined && o.deadlineMinutes < now;

/** Aba "Missões": missões, eventos e prazos que o Mestre registra conforme a história. Oferecidas com Aceitar e Recusar. */
export default function ObjectivesView({ state, ruleset, playerXp, onDecide, disabled, onFix }: {
  state: Record<string, unknown>; ruleset: Ruleset; playerXp: number; onDecide: Decide; disabled?: boolean; onFix?: Fix;
}) {
  const now = getClock(state)?.minutes;
  const all = getObjectives(state);
  const table = getTable(state);
  // prazo mais próximo primeiro; sem prazo no fim
  const byDeadline = (a: Objective, b: Objective) => (a.deadlineMinutes ?? Infinity) - (b.deadlineMinutes ?? Infinity);
  const offered = all.filter((o) => o.status === "oferecida").sort(byDeadline);
  const open = all.filter((o) => o.status === "aberto").sort(byDeadline);
  const closed = all.filter((o) => o.status !== "aberto" && o.status !== "oferecida").reverse();

  const item = (o: Objective, n: number) => {
    const isOpen = o.status === "aberto";
    const isOffer = o.status === "oferecida";
    const xp = isOpen || isOffer ? objectiveXp(o, ruleset, table, playerXp) : null;
    const left = isOpen && o.deadlineMinutes !== undefined && now !== undefined ? o.deadlineMinutes - now : null;
    const u = urgency(left);
    // quanto do prazo já passou, desde que a missão surgiu
    const span = o.deadlineMinutes !== undefined ? o.deadlineMinutes - o.createdAt : 0;
    const used = left !== null && span > 0 ? Math.max(0, Math.min(1, 1 - left / span)) : null;
    return (
      <div key={o.id} className={`${s.card} ${s.quest}${u ? ` ${s[u]}` : ""}${isOffer ? ` ${s.offered}` : isOpen ? "" : ` ${s.closed}`}`}
        style={{ animationDelay: `${Math.min(n, 8) * 25}ms` }}>
        <div className={s.row} style={{ alignItems: "flex-start" }}>
          <div className={s.grow}>
            <div className={s.title}>{o.title}</div>
          </div>
          {xp !== null && (
            <span className={`${s.chip} ${s.xp}`} data-tip={`XP ao concluir (${SIZE_LABEL[o.xpSize!]}, pela regra de XP da mesa)`}>
              {o.xpSize === "excepcional" ? "" : "≈ "}{xp} XP
            </span>
          )}
          {isOpen || isOffer ? (
            <span className={s.chip}>{OBJECTIVE_KIND_LABEL[o.kind] || o.kind}</span>
          ) : (
            <span className={`${s.chip} ${o.status === "concluido" ? s.ok : o.status === "perdido" ? s.bad : ""}`}>{STATUS_LABEL[o.status]}</span>
          )}
        </div>
        {o.giver && <div className={s.sub}>Oferecida por {o.giver}</div>}
        {o.description && <div className={s.sub}>{o.description}</div>}
        {o.reward && <span className={s.reward}><StarIcon /> {o.reward}</span>}
        {!!o.pay && ruleset.currency && <span className={s.reward}>Sua parte: {formatMoney(o.pay, ruleset.currency)}{o.payGiven ? " (recebida)" : ""}</span>}
        {isOffer && o.deadlineMinutes !== undefined && (
          <div className={s.deadline}><span>{isLate(o, now) ? "o prazo já passou" : `prazo se aceitar: até ${formatClock(o.deadlineMinutes)}`}</span></div>
        )}
        {isOffer && (
          <div className={s.row} style={{ justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn ghost small" disabled={disabled} onClick={() => onDecide(o, false)}>Recusar</button>
            <button className="btn small" disabled={disabled || isLate(o, now)} onClick={() => onDecide(o, true)}>Aceitar</button>
          </div>
        )}
        {isOpen && (
          <>
            <div className={s.deadline}>
              <span>{o.deadlineMinutes === undefined ? "sem prazo" : `até ${formatClock(o.deadlineMinutes)}`}</span>
              {left !== null && <span className={s.left}>{formatRemaining(left)}</span>}
            </div>
            {used !== null && <div className={s.timebar}><span style={{ transform: `scaleX(${used})` }} /></div>}
          </>
        )}
        {onFix && !isOffer && (
          <label className={s.fixStatus}>
            Corrigir status
            <select value={o.status} disabled={disabled} onChange={(e) => onFix(o, e.target.value as Parameters<Fix>[1])}>
              {o.status === "perdido" && <option value="perdido" disabled>perdido</option>}
              <option value="aberto">aberto</option>
              <option value="concluido">concluído</option>
              <option value="cancelado">cancelado</option>
            </select>
          </label>
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
          Missão oferecida ainda não foi aceita: o prazo só corre depois que você aceitar. A XP mostrada vem pela regra de
          XP da mesa e entra na ficha quando a missão é concluída.
        </p>
      </details>
      {offered.length > 0 && (
        <>
          <div className={s.head}><h4>Oferecidas</h4><span className={s.count}>{offered.length}</span></div>
          {offered.map(item)}
        </>
      )}
      {!open.length ? (
        !offered.length && <div className={s.empty}>
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

/** Missão oferecida na tela, para aceitar ou recusar sem passar pelo chat. Fechar deixa a decisão para a aba Missões. */
export function OfferModal({ o, state, ruleset, playerXp, onDecide, onClose, disabled }: {
  o: Objective; state: Record<string, unknown>; ruleset: Ruleset; playerXp: number; onDecide: Decide; onClose: () => void; disabled?: boolean;
}) {
  const now = getClock(state)?.minutes;
  const xp = objectiveXp(o, ruleset, getTable(state), playerXp);
  const late = isLate(o, now);
  return (
    <div className="modal-backdrop" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="offer-title" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="offer-title">{o.title}</h3>
        </div>
        <div className="modal-body" style={{ display: "grid", gap: "var(--s-3)" }}>
          <p className="muted" style={{ margin: 0 }}>
            {OBJECTIVE_KIND_LABEL[o.kind] || o.kind} oferecida{o.giver ? ` por ${o.giver}` : ""}
          </p>
          {o.description && <p style={{ margin: 0 }}>{o.description}</p>}
          {o.reward && <span className={s.reward}><StarIcon /> {o.reward}</span>}
          {!!o.pay && ruleset.currency && <span className={s.reward}>Sua parte ao concluir: {formatMoney(o.pay, ruleset.currency)}</span>}
          {xp !== null && (
            <span className="muted num">
              {o.xpSize === "excepcional" ? "" : "≈ "}{xp} XP ao concluir ({SIZE_LABEL[o.xpSize!]}, pela regra de XP da mesa)
            </span>
          )}
          <span className="muted">
            {o.deadlineMinutes === undefined ? "Sem prazo" : late ? "O prazo já passou: só o Mestre pode dar um prazo novo." : `Prazo se aceitar: até ${formatClock(o.deadlineMinutes)}`}
          </span>
        </div>
        <div className="modal-foot">
          <button className="btn ghost small" onClick={onClose}>Decidir depois</button>
          <button className="btn small" disabled={disabled} onClick={() => onDecide(o, false)}>Recusar</button>
          <button className="btn primary small" autoFocus disabled={disabled || late} onClick={() => onDecide(o, true)}>Aceitar</button>
        </div>
      </div>
    </div>
  );
}

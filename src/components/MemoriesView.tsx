"use client";
import { useState } from "react";
import s from "./SidePanels.module.css";

type Memory = { id: number; kind: string; subject: string | null; content: string; importance: number };

const KINDS: [key: string, label: string][] = [
  ["milestone", "Marcos"],
  ["event", "Eventos"],
  ["npc", "NPCs"],
  ["discovery", "Descobertas"],
  ["relationship", "Relações"],
];
const ONE: Record<string, string> = { milestone: "Marco", event: "Evento", npc: "NPC", discovery: "Descoberta", relationship: "Relação" };

/** Memória da campanha: diretrizes fora do jogo à parte, a história numa linha do tempo (mais recente no topo). */
export default function MemoriesView({ memories }: { memories: Memory[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const directives = memories.filter((m) => m.kind === "directive");
  const story = memories.filter((m) => m.kind !== "directive");
  const shown = story.filter((m) => !filter || m.kind === filter);
  const kinds = KINDS.filter(([k]) => story.some((m) => m.kind === k));
  return (
    <div className={s.wrap}>
      {directives.length > 0 && (
        <section className={s.ooc} aria-label="Diretrizes fora do jogo">
          <h4>Diretrizes fora do jogo ({directives.length})</h4>
          <ul>
            {directives.map((d) => (
              <li key={d.id}>
                {d.content}
                {d.subject === "proxima_cena" && <span className={s.subject}> · nesta cena e na próxima</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {kinds.length > 1 && (
        <div className={s.filters} role="group" aria-label="Tipo de memória">
          <button className={`pill filter-pill${filter ? "" : " on"}`} aria-pressed={!filter} onClick={() => setFilter(null)}>Tudo</button>
          {kinds.map(([k, label]) => (
            <button key={k} className={`pill filter-pill${filter === k ? " on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label} <span className="num">{story.filter((m) => m.kind === k).length}</span>
            </button>
          ))}
        </div>
      )}
      {!story.length ? (
        <div className={s.empty}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6M9 18h3" />
          </svg>
          <b>Nada registrado ainda</b>
          O Cronista anota os marcos, descobertas e relações conforme você joga. O Mestre consulta tudo isso para manter a história coerente.
        </div>
      ) : (
        <ol className={s.timeline}>
          {shown.map((m, n) => (
            <li key={m.id} className={`${s.event} ${s[`k-${m.kind}`] || ""}`} style={{ animationDelay: `${Math.min(n, 10) * 20}ms` }}>
              <span className={s.dot} aria-hidden="true" />
              <span className={s.kind}>{ONE[m.kind] || m.kind}</span>
              {m.subject && <span className={s.subject}> · {m.subject}</span>}
              <span className={s.pips} title={`Importância ${m.importance} de 5`}>
                {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= m.importance ? s.on : undefined} />)}
              </span>
              <p>{m.content}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import type { CampaignView, EventView } from "@/lib/campaignView";
import { clockParts, period } from "@/lib/clock";
import s from "./SidePanels.module.css";

type Filter = "all" | "mine" | "public";
const FILTERS: [Filter, string][] = [
  ["all", "Tudo"],
  ["mine", "Só você sabe"],
  ["public", "Públicos"],
];

const npcsWho = (e: EventView) => e.knownBy.filter((k) => k.kind !== "player");
const onlyYou = (e: EventView) => !e.public && npcsWho(e).length === 0;
const how = (k: EventView["knownBy"][number]) => (k.access === "told" ? `contaram${k.from ? `: ${k.from}` : ""}` : k.access === "public" ? "boato" : "viu");

/**
 * Memória da campanha: diretrizes fora do jogo à parte; os fatos da história numa linha do tempo (mais recente no
 * topo), cada um com quem sabe (viu, contaram, público). É o que cada NPC pode citar.
 */
export default function MemoriesView({ memories, events }: { memories: CampaignView["memories"]; events: EventView[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const directives = memories.filter((m) => m.kind === "directive");
  const shown = events.filter((e) => filter === "all" || (filter === "public" ? e.public : onlyYou(e)));
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
      {events.length > 0 && (
        <div className={s.filters} role="group" aria-label="Quem sabe">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={`pill filter-pill${filter === k ? " on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label} <span className="num">{k === "all" ? events.length : events.filter(k === "public" ? (e) => e.public : onlyYou).length}</span>
            </button>
          ))}
        </div>
      )}
      {!events.length ? (
        <div className={s.empty}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6M9 18h3" />
          </svg>
          <b>Nada registrado ainda</b>
          Os fatos que a história deixa (acordos, descobertas, o que alguém contou) ficam aqui com quem sabe de cada um.
        </div>
      ) : (
        <ol className={s.timeline}>
          {shown.map((e, n) => {
            const npcs = npcsWho(e);
            return (
              <li key={e.id} className={`${s.event} ${e.public ? s["k-milestone"] : onlyYou(e) ? s["k-discovery"] : s["k-event"]}`} style={{ animationDelay: `${Math.min(n, 10) * 20}ms` }}>
                <span className={s.dot} aria-hidden="true" />
                <span className={s.kind}>{e.public ? "Público" : onlyYou(e) ? "Só você" : "Fato"}</span>
                {e.minute !== null && <span className={s.subject}> · Dia {clockParts(e.minute).day}, {period(e.minute)}</span>}
                <p>{e.text}</p>
                <span className={s.subject}>
                  {e.public ? "Todos sabem" : npcs.length ? `Sabem: ${npcs.map((k) => `${k.name} (${how(k)})`).join(", ")}` : "Nenhum NPC sabe"}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import type { Ability, Character, Ruleset } from "@/lib/types";
import { costsByRankText } from "@/lib/ruleset";
import { costAdjustText, DEFAULT_MASTERY_BONUS, effectiveCost, mastery, masteryBonus } from "@/lib/progression";
import s from "./AbilitiesView.module.css";

const NO_RANK = "sem rank";

/** Anel de domínio 0-100 com o número no meio. */
function Ring({ value, estimated }: { value: number; estimated: boolean }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <span className={`${s.ring}${value >= 100 ? ` ${s.full}` : ""}`}
      title={`Domínio ${value}%${estimated ? " (estimado)" : ""}`}>
      <svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
        <circle cx="20" cy="20" r={r} className={s.ringTrack} />
        <circle cx="20" cy="20" r={r} className={s.ringFill} strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <span className={`${s.ringN} num`}>{value}<small>%</small></span>
      <span className="sr-only">Domínio {value}%</span>
    </span>
  );
}

/** Aba de habilidades (Jutsus em Naruto): visível mesmo vazia, com o que cada uma custa e faz. */
// onUse: só na aba do jogador (põe a técnica no campo da ação); na ficha de NPC não há
export default function AbilitiesView({ char, ruleset, onUse }: { char: Character; ruleset: Ruleset; onUse?: (name: string) => void }) {
  const label = ruleset.abilitiesLabel || "Habilidades";
  const resLabel = (key: string) => ruleset.resources.find((r) => r.key === key)?.label || key;
  const costs = ruleset.abilityCosts;
  const abilities = char.sheet.abilities;
  const [rank, setRank] = useState<string | null>(null); // null = todos
  const [type, setType] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set()); // cards expandidos; o padrão é recolhido
  const toggle = (name: string) =>
    setOpen((o) => { const n = new Set(o); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const rankOf = (a: Ability) => a.rank || NO_RANK;
  // só as opções que existem na ficha, na ordem do ruleset, com a contagem
  // ranks fora do ruleset (ex.: "E" vindo do Mestre) também viram filtro
  const rankOpts = [...new Set([...ruleset.abilityRanks, ...abilities.map(rankOf).filter((r) => r !== NO_RANK), NO_RANK])]
    .filter((r) => abilities.some((a) => rankOf(a) === r));
  const typeOpts = [...new Set(abilities.map((a) => a.type))].sort(
    (x, y) => ruleset.abilityTypes.findIndex((t) => t.key === x) - ruleset.abilityTypes.findIndex((t) => t.key === y)
  );
  const typeLabel = (k: string) => ruleset.abilityTypes.find((t) => t.key === k)?.label || k;
  const shown = abilities.filter((a) => (!rank || rankOf(a) === rank) && (!type || a.type === type));
  const filterRow = (
    title: string,
    opts: string[],
    value: string | null,
    set: (v: string | null) => void,
    count: (o: string) => number,
    label: (o: string) => string
  ) =>
    opts.length > 1 && (
      <div className={s.filters} role="group" aria-label={title}>
        <span className={s.filterTitle}>{title}</span>
        {[null, ...opts].map((o) => (
          <button key={o ?? "*"} className={`pill filter-pill${value === o ? " on" : ""}`} aria-pressed={value === o}
            onClick={() => set(o)}>
            {o === null ? "Todos" : <>{label(o)} <span className="num">{count(o)}</span></>}
          </button>
        ))}
      </div>
    );

  const item = (a: Ability, i: number) => {
    const cost = effectiveCost(ruleset, a);
    const progress = mastery(a);
    const bonus = masteryBonus(ruleset, a);
    const adj = cost?.base ? costAdjustText(cost.mult) : "";
    const marks = [...(a.milestones || [])].sort((x, y) => x.threshold - y.threshold);
    const isOpen = open.has(a.name);
    return (
      <article key={a.name} className={s.item} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
        <div className={s.top}>
          {isOpen && <Ring value={progress} estimated={a.progress === undefined} />}
          <button type="button" className={s.title} aria-expanded={isOpen} onClick={() => toggle(a.name)}>
            <h4 className={s.name}>{a.name}</h4>
            <div className={s.meta}>
              {isOpen && a.rank && <span className={s.rank}>{a.rank}</span>}
              <span>{typeLabel(a.type)}</span>
            </div>
          </button>
          {onUse && (
            <button className={`btn ghost small ${s.use}`} onClick={() => onUse(a.name)} data-tip="Escrever no campo da ação" data-tip-align="end">
              Usar
            </button>
          )}
        </div>
        <div className={s.stats}>
          {cost && (
            <span className={s.stat} title={adj ? `Custo base ${cost.base}; ${adj}` : "Custo por uso"}>
              <span className={s.statK}>custo</span>
              {cost.amount || cost.base ? (
                <span><b className="num">{cost.amount}</b> {resLabel(cost.resource)}{adj && cost.amount !== cost.base && <del className={s.base}>{cost.base}</del>}</span>
              ) : <span>livre</span>}
            </span>
          )}
          <span className={s.stat} title="Bônus do domínio no teste (somado a 1d20 + atributo)">
            <span className={s.statK}>teste</span><b className="num">+{bonus}</b>
          </span>
          {isOpen && a.damage && (
            <span className={s.stat}><span className={s.statK}>dano</span><b className="num">{a.damage}</b></span>
          )}
        </div>
        {isOpen && <>
        {a.effect && <p className={s.text}>{a.effect}</p>}
        {a.requirements && <p className={s.req}><span>Requisitos</span> {a.requirements}</p>}
        {a.description && <p className={s.desc}>{a.description}</p>}
        {marks.length > 0 && (
          <ol className={s.marks} aria-label="Marcos de domínio">
            {marks.map((m) => {
              const got = progress >= m.threshold;
              return (
                <li key={m.threshold} className={got ? s.got : undefined}>
                  <span className={`${s.markAt} num`}>{m.threshold}%</span>
                  <span>{m.description}</span>
                </li>
              );
            })}
          </ol>
        )}
        </>}
      </article>
    );
  };

  // na ficha de NPC (modal) basta o título; a explicação é para o jogador
  if (char.kind === "npc")
    return (
      <section className={s.wrap}>
        <h4 className={s.npcTitle}>{label}</h4>
        {abilities.map(item)}
      </section>
    );
  return (
    <section className={s.wrap}>
      <details className={s.how}>
        <summary>Como funcionam {label.toLowerCase()}</summary>
        <p>
          {label} que {char.name} sabe usar. O Mestre registra aqui o que você usa ou aprende na história, com o custo e o efeito.
          {costs && ` Custo por rank (${resLabel(costs.resource)}): ${costsByRankText(ruleset)}.`}
          {` O domínio sobe com o uso e o treino e dá bônus no teste (${(ruleset.masteryBonus ?? DEFAULT_MASTERY_BONUS)
            .map((b) => `${b.min}%: +${b.value}`)
            .join(", ")}); domínio baixo encarece o custo e domínio total o barateia.`}
        </p>
      </details>
      {!abilities.length && (
        <div className={s.empty}>
          <p>Nenhuma registrada ainda.</p>
          <p className="muted">Use uma técnica na história ou peça ao Mestre para treinar uma nova: ela aparece aqui com custo, efeito e domínio.</p>
        </div>
      )}
      {abilities.length > 1 && (
        <div className={s.filterBox}>
          {filterRow("Rank", rankOpts, rank, setRank, (o) => abilities.filter((a) => rankOf(a) === o).length, (o) => o)}
          {filterRow("Tipo", typeOpts, type, setType, (o) => abilities.filter((a) => a.type === o).length, typeLabel)}
        </div>
      )}
      {abilities.length > 0 && !shown.length && <p className="muted">Nenhuma com esses filtros.</p>}
      {shown.map(item)}
    </section>
  );
}

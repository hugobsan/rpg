"use client";
import { useState } from "react";
import type { Ability, Character, Ruleset } from "@/lib/types";
import { abilityCost, costsByRankText, currentMilestone, nextMilestone } from "@/lib/ruleset";

/** Aba de habilidades (Jutsus em Naruto): visível mesmo vazia, com o que cada uma custa e faz. */
export default function AbilitiesView({ char, ruleset }: { char: Character; ruleset: Ruleset }) {
  const label = ruleset.abilitiesLabel || "Habilidades";
  const resLabel = (key: string) => ruleset.resources.find((r) => r.key === key)?.label || key;
  const costs = ruleset.abilityCosts;
  const abilities = char.sheet.abilities;
  const [rank, setRank] = useState<string | null>(null); // null = todos
  const [type, setType] = useState<string | null>(null);
  const NO_RANK = "—";
  const rankOf = (a: Ability) => a.rank || NO_RANK;
  // só as opções que existem na ficha, na ordem do ruleset, com a contagem
  const rankOpts = [...ruleset.abilityRanks, NO_RANK].filter((r) => abilities.some((a) => rankOf(a) === r));
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
  ) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginBottom: 6 }}>
      <span className="muted" style={{ fontSize: 12, minWidth: 34 }}>{title}</span>
      {[null, ...opts].map((o) => (
        <button key={o ?? "*"} className={`pill filter-pill${value === o ? " on" : ""}`} aria-pressed={value === o}
          onClick={() => set(o)}>
          {o === null ? "Todos" : `${label(o)} · ${count(o)}`}
        </button>
      ))}
    </div>
  );

  const item = (a: Ability) => {
    const cost = abilityCost(ruleset, a);
    const progress = a.progress ?? null;
    const cur = currentMilestone(a);
    const next = nextMilestone(a);
    return (
      <div key={a.name} className="ability-item">
        <div className="name">
          {a.name} {a.rank && <span className="pill">{a.rank}</span>}
          {cost && <span className="pill">{cost.amount ? `${cost.amount} ${resLabel(cost.resource)}` : "sem custo"}</span>}
          {a.damage && <span className="pill">dano {a.damage}</span>}
          {progress !== null && <span className="pill">{progress}%</span>}
        </div>
        <div className="sub">{ruleset.abilityTypes.find((t) => t.key === a.type)?.label || a.type}</div>
        {a.effect && <div className="sub" style={{ marginTop: 4 }}><b>Efeito:</b> {a.effect}</div>}
        {a.requirements && <div className="sub"><b>Requisitos:</b> {a.requirements}</div>}
        {a.description && <div className="sub" style={{ marginTop: 4, opacity: 0.8 }}>{a.description}</div>}
        {progress !== null && (
          <div className="bar-outer" style={{ height: 7, marginTop: 6 }}>
            <div className="bar-inner" style={{ width: `${progress}%`, background: "var(--accent)" }} />
          </div>
        )}
        {cur && <div className="sub" style={{ marginTop: 5 }}>▸ {cur.description}</div>}
        {next && (
          <div className="sub" style={{ opacity: 0.7 }}>
            próximo marco aos {next.threshold}%: {next.description}
          </div>
        )}
      </div>
    );
  };

  // na ficha de NPC (modal) basta o título; a explicação é para o jogador
  if (char.kind === "npc")
    return (
      <div>
        <h4 style={{ margin: "14px 0 8px" }}>{label}</h4>
        {abilities.map(item)}
      </div>
    );
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        {label} que {char.name} sabe usar. O Mestre registra aqui o que você usa ou aprende na história, com o custo e o efeito.
        {costs &&
          ` Custo por rank (${resLabel(costs.resource)}): ${costsByRankText(ruleset)}.`}
      </p>
      {!abilities.length && <p className="muted">Nenhuma registrada ainda.</p>}
      {abilities.length > 1 && (
        <div style={{ marginBottom: 6 }}>
          {filterRow("Rank", rankOpts, rank, setRank, (o) => abilities.filter((a) => rankOf(a) === o).length, (o) => o)}
          {filterRow("Tipo", typeOpts, type, setType, (o) => abilities.filter((a) => a.type === o).length, typeLabel)}
        </div>
      )}
      {abilities.length > 0 && !shown.length && <p className="muted">Nenhum com esses filtros.</p>}
      {shown.map(item)}
    </div>
  );
}

"use client";
import type { Ability, Character, Ruleset } from "@/lib/types";
import { abilityCost, costsByRankText, currentMilestone, nextMilestone } from "@/lib/ruleset";

/** Aba de habilidades (Jutsus em Naruto): visível mesmo vazia, com o que cada uma custa e faz. */
export default function AbilitiesView({ char, ruleset }: { char: Character; ruleset: Ruleset }) {
  const label = ruleset.abilitiesLabel || "Habilidades";
  const resLabel = (key: string) => ruleset.resources.find((r) => r.key === key)?.label || key;
  const costs = ruleset.abilityCosts;
  const abilities = char.sheet.abilities;

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
      {abilities.map(item)}
    </div>
  );
}

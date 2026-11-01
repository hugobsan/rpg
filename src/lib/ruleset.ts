import { Ability, AbilityMilestone, Ruleset, Sheet } from "./types";
import { costAdjustText, effectiveCost, KIT_MASTERY, mastery, masteryBonus, progressionPromptLines } from "./progression";

/** Ruleset padrão, agnóstico de cenário. Presets (ex: Naruto) são importados por JSON. */
export const DEFAULT_RULESET: Ruleset = {
  name: "Aventura Genérica",
  description:
    "Sistema agnóstico de cenário: fantasia, ficção científica, mundo moderno — o Mestre adapta.",
  loreNotes: "",
  canonBased: false,
  attributes: [
    { key: "for", label: "Força", min: 1, max: 20, default: 8 },
    { key: "des", label: "Destreza", min: 1, max: 20, default: 8 },
    { key: "con", label: "Constituição", min: 1, max: 20, default: 8 },
    { key: "int", label: "Inteligência", min: 1, max: 20, default: 8 },
    { key: "sab", label: "Sabedoria", min: 1, max: 20, default: 8 },
    { key: "car", label: "Carisma", min: 1, max: 20, default: 8 },
  ],
  resources: [
    { key: "hp", label: "Vida", defaultMax: 30, color: "#e0524d" },
    { key: "energy", label: "Energia", defaultMax: 20, color: "#4d9de0" },
  ],
  abilityTypes: [
    { key: "combat", label: "Combate" },
    { key: "utility", label: "Utilidade" },
    { key: "social", label: "Social" },
  ],
  abilityRanks: ["Iniciante", "Competente", "Perito", "Mestre"],
  ranks: [
    { key: "novice", label: "Novato", xpRequired: 0 },
    { key: "adventurer", label: "Aventureiro", xpRequired: 300 },
    { key: "veteran", label: "Veterano", xpRequired: 900 },
    { key: "hero", label: "Herói", xpRequired: 2700 },
    { key: "legend", label: "Lenda", xpRequired: 6500 },
  ],
  creationPoints: 12,
  extraFields: [
    { key: "origin", label: "Origem" },
    { key: "trait", label: "Traço marcante" },
  ],
  diceNotes:
    "Testes usam 1d20 + atributo relevante contra dificuldade 10 (fácil), 15 (média), 20 (difícil). Dano por dados menores (1d4 a 2d8).",
};

/** Valida superficialmente um ruleset importado e preenche defaults. */
export function normalizeRuleset(input: unknown): Ruleset {
  const r = { ...DEFAULT_RULESET, ...(input as Partial<Ruleset>) };
  if (!Array.isArray(r.attributes) || r.attributes.length === 0)
    throw new Error("Ruleset inválido: attributes vazio");
  if (!Array.isArray(r.resources) || r.resources.length === 0)
    throw new Error("Ruleset inválido: resources vazio");
  r.abilityTypes = Array.isArray(r.abilityTypes) ? r.abilityTypes : [];
  r.abilityElements = Array.isArray(r.abilityElements) && r.abilityElements.length ? r.abilityElements : undefined;
  r.abilityRanks = Array.isArray(r.abilityRanks) ? r.abilityRanks : [];
  r.ranks = Array.isArray(r.ranks) ? r.ranks : [];
  r.extraFields = Array.isArray(r.extraFields) ? r.extraFields : [];
  // campos de habilidade opcionais (rulesets antigos não têm)
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  r.world = text(r.world);
  r.abilityNaming = text(r.abilityNaming);
  r.abilitiesLabel = typeof r.abilitiesLabel === "string" && r.abilitiesLabel.trim() ? r.abilitiesLabel : "Habilidades";
  const ac = r.abilityCosts;
  r.abilityCosts = ac && typeof ac.resource === "string" && ac.byRank && typeof ac.byRank === "object" ? ac : undefined;
  const sa = r.startingAbilities;
  r.startingAbilities =
    sa && typeof sa === "object" && !Array.isArray(sa)
      ? Object.fromEntries(Object.entries(sa).filter(([, v]) => Array.isArray(v)))
      : undefined;
  return r as Ruleset;
}

/** Ficha vazia coerente com o ruleset. */
export function blankSheet(ruleset: Ruleset): Sheet {
  const attributes: Record<string, number> = {};
  for (const a of ruleset.attributes) attributes[a.key] = a.default;
  const resources: Record<string, { current: number; max: number }> = {};
  for (const res of ruleset.resources)
    resources[res.key] = { current: res.defaultMax, max: res.defaultMax };
  return {
    attributes,
    resources,
    abilities: [],
    inventory: [],
    rank: ruleset.ranks[0]?.key,
    xp: 0,
    extra: {},
  };
}

/** Custo base: 0 se a técnica não gasta recurso; senão o do rank no ruleset (o custo depende da mesa, não da biblioteca). */
export function abilityCost(r: Ruleset, a: Ability): { resource: string; amount: number } | null {
  if (!r.abilityCosts) return null; // mesa sem custo de habilidade
  const amount = a.costFree ? 0 : a.rank ? r.abilityCosts.byRank[a.rank] : undefined;
  return amount === undefined ? null : { resource: r.abilityCosts.resource, amount };
}

/** "D=3, C=6, ..." na ordem de abilityRanks (o JSONB do Postgres reordena as chaves). */
export function costsByRankText(r: Ruleset): string {
  const by = r.abilityCosts?.byRank || {};
  const keys = [...r.abilityRanks.filter((k) => k in by), ...Object.keys(by).filter((k) => !r.abilityRanks.includes(k))];
  return keys.map((k) => `${k}=${by[k]}`).join(", ");
}

/** Kit de habilidades de um rank, somando os ranks anteriores (o de cima vence em nome repetido). Já treinado: domínio KIT_MASTERY. */
export function startingKit(r: Ruleset, rankKey?: string): Ability[] {
  const kit = new Map<string, Ability>();
  for (const rank of r.ranks) {
    for (const a of r.startingAbilities?.[rank.key] || []) kit.set(a.name.toLowerCase(), { ...a, progress: a.progress ?? KIT_MASTERY });
    if (rank.key === rankKey) break;
  }
  return [...kit.values()];
}

/** Linha compacta de uma habilidade para o prompt: tipo, rank, domínio (bônus), custo efetivo, dano, efeito, requisitos. */
export function abilityPromptLine(r: Ruleset, a: Ability, textMax = Infinity): string {
  const cut = (t: string) => (t.length > textMax ? `${t.slice(0, textMax).trimEnd()}…` : t);
  const cost = effectiveCost(r, a);
  const adj = cost ? costAdjustText(cost.mult) : "";
  const bits = [
    a.type,
    a.rank && `rank ${a.rank}`,
    `domínio ${mastery(a)}% (+${masteryBonus(r, a)} no teste)`,
    cost &&
      (cost.amount || cost.base
        ? `custo ${cost.amount} ${cost.resource}${adj ? ` (base ${cost.base} do rank, ${adj})` : " (padrão do rank)"}`
        : "sem custo"),
    a.damage && `dano ${a.damage}`,
  ].filter(Boolean);
  let line = `${a.name} [${bits.join(", ")}]`;
  if (a.effect) line += ` — efeito: ${cut(a.effect)}`;
  if (a.requirements) line += ` — requisitos: ${cut(a.requirements)}`;
  return line;
}

/** Marco de domínio ativo no progresso atual (o mais alto threshold <= progress). */
export function currentMilestone(a: Ability): AbilityMilestone | null {
  if (a.progress === undefined || !a.milestones?.length) return null;
  const reached = a.milestones
    .filter((m) => m.threshold <= a.progress!)
    .sort((x, y) => y.threshold - x.threshold);
  return reached[0] || null;
}

/** Próximo marco ainda não alcançado. */
export function nextMilestone(a: Ability): AbilityMilestone | null {
  if (a.progress === undefined || !a.milestones?.length) return null;
  const upcoming = a.milestones
    .filter((m) => m.threshold > a.progress!)
    .sort((x, y) => x.threshold - y.threshold);
  return upcoming[0] || null;
}

/** Resumo textual do ruleset para prompts (compacto). */
export function rulesetPromptSummary(r: Ruleset): string {
  const lines = [
    `Sistema: ${r.name} — ${r.description}`,
    `Atributos:\n${r.attributes.map((a) => `- ${a.label} (${a.key}, ${a.min}-${a.max})${a.description ? `: ${a.description}` : ""}`).join("\n")}`,
    `Recursos/barras: ${r.resources.map((x) => `${x.label} (${x.key})`).join(", ")}`,
    `Tipos de habilidade: ${r.abilityTypes.map((t) => `${t.label} (${t.key})`).join(", ")}`,
    ...(r.abilityElements ? [`Elementos de habilidade: ${r.abilityElements.map((t) => `${t.label} (${t.key})`).join(", ")}`] : []),
    `Níveis de habilidade: ${r.abilityRanks.join(" < ")}`,
    `Cargos (posição na história; só mudam por set_rank, nunca sozinhos pela XP): ${r.ranks.map((k) => k.label).join(", ")}`,
    ...progressionPromptLines(r),
  ];
  if (r.extraFields.length)
    lines.push(
      `Campos extras da ficha: ${r.extraFields.map((f) => `${f.label} (${f.key})`).join(", ")}`
    );
  if (r.diceNotes) lines.push(`Rolagens: ${r.diceNotes}`);
  if (r.abilityCosts)
    lines.push(
      `Custo padrão de habilidade por rank (${r.abilityCosts.resource}): ${costsByRankText(r)}`
    );
  if (r.abilityNaming) lines.push(`Padrão de nomes das habilidades: ${r.abilityNaming}`);
  const kits = r.ranks
    .filter((k) => r.startingAbilities?.[k.key]?.length)
    .map((k) => `${k.label}: ${r.startingAbilities![k.key].map((a) => a.name).join(", ")}`);
  if (kits.length)
    lines.push(`Kit que todo personagem sabe ao chegar ao rank (cumulativo): ${kits.join(" | ")}`);
  if (r.progressionNotes) lines.push(`Progressão de habilidades: ${r.progressionNotes}`);
  if (r.loreNotes) lines.push(`Cenário/lore: ${r.loreNotes}`);
  return lines.join("\n");
}

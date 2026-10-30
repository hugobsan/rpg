import { Ability, AbilityMilestone, Ruleset, Sheet } from "./types";

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
  r.abilityRanks = Array.isArray(r.abilityRanks) ? r.abilityRanks : [];
  r.ranks = Array.isArray(r.ranks) ? r.ranks : [];
  r.extraFields = Array.isArray(r.extraFields) ? r.extraFields : [];
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
    `Níveis de habilidade: ${r.abilityRanks.join(" < ")}`,
    `Progressão (rank: xp acumulado): ${r.ranks.map((k) => `${k.label}=${k.xpRequired}`).join(", ")}`,
  ];
  if (r.extraFields.length)
    lines.push(
      `Campos extras da ficha: ${r.extraFields.map((f) => `${f.label} (${f.key})`).join(", ")}`
    );
  if (r.diceNotes) lines.push(`Rolagens: ${r.diceNotes}`);
  if (r.progressionNotes) lines.push(`Progressão de habilidades: ${r.progressionNotes}`);
  if (r.loreNotes) lines.push(`Cenário/lore: ${r.loreNotes}`);
  return lines.join("\n");
}

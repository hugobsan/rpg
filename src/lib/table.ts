// Regras da mesa (campaign.state.table): dificuldade e dados ajustáveis durante a campanha.
// Puro (sem banco): serve ao servidor e à UI.
import type { DiceResult, Difficulty, RestKind, SceneMode, TableRules } from "./types";

/** Presets: ajuste padrão da CD e o que o nível significa para o tom do Mestre. */
export const DIFFICULTIES: { key: Difficulty; label: string; dcOffset: number; tone: string }[] = [
  { key: "story", label: "História", dcOffset: -5, tone: "a história vem antes do desafio: falhas complicam ou atrasam, nunca matam; inimigos fracos e previsíveis; recursos sobram; pistas claras e repetidas." },
  { key: "easy", label: "Fácil", dcOffset: -2, tone: "inimigos abaixo do personagem e pouco táticos; recursos folgados; pistas generosas; ferimento grave é raro." },
  { key: "normal", label: "Normal", dcOffset: 0, tone: "desafio justo: inimigos à altura e com bom senso, recursos contados, pistas que pedem atenção; erro tem custo." },
  { key: "hard", label: "Difícil", dcOffset: 2, tone: "inimigos táticos, bem equipados e com reforços; recursos escassos; pistas sutis; erro custa caro e a morte é possível." },
  { key: "brutal", label: "Brutal", dcOffset: 5, tone: "letal: inimigos usam tudo o que têm, sem misericórdia; recursos raros; pistas escondidas ou enganosas; a morte do personagem é real." },
];

export const DEFAULT_TABLE: TableRules = { difficulty: "normal", dcOffset: 0, categories: [], crits: false };

export const getTable = (state: Record<string, unknown> | null | undefined): TableRules => ({
  ...DEFAULT_TABLE,
  ...(state?.table as Partial<TableRules> | undefined),
});

// como o Mestre conduz cada modo de cena: o texto do modo atual vai no contexto de todo turno; a mesa pode trocar cada um
export const MODE_HINTS: Record<SceneMode, string> = {
  exploration: "Cena de EXPLORAÇÃO: descrições sensoriais ricas, ritmo médio, semeie ganchos.",
  dialogue: "Cena de DIÁLOGO: respostas curtas, foco nas falas e linguagem corporal dos NPCs. Não resuma conversas — interprete-as.",
  battle: "Cena de BATALHA: turno a turno, tático e tenso. Descreva posições e aberturas, peça a ação do jogador, resolva com rolagens e narre dano e gasto com números claros. Inimigos agem com inteligência coerente.",
  training: "Cena de TREINAMENTO: resolva com train informando horas realistas (ele avança o relógio e aplica o ganho de domínio ou atributo); respeite a recusa por exaustão. Deixe claros na narração os marcos reais (o Escrivão dá a XP).",
  downtime: "Cena de DESCANSO: leve e breve; avance o tempo com resumos e cenas curtas de personagem.",
};
export const MODE_LABELS: Record<SceneMode, string> = {
  exploration: "Exploração", dialogue: "Diálogo", battle: "Batalha", training: "Treino", downtime: "Descanso",
};
export const modeHint = (t: TableRules, mode: string) => t.modes?.[mode as SceneMode] || MODE_HINTS[mode as SceneMode] || "";

// ritmo de XP: % do que falta para o próximo nível por feito comum (min a max) e por feito grande (até great)
export const XP_PACES = [
  { key: "lento", label: "Lento", xp: { min: 2, max: 5, great: 12 } },
  { key: "normal", label: "Normal", xp: { min: 5, max: 10, great: 25 } },
  { key: "rapido", label: "Rápido", xp: { min: 10, max: 20, great: 40 } },
];
export const xpRule = (t: TableRules) => t.xp ?? XP_PACES[1].xp;
export const xpRuleText = (t: TableRules) => {
  const x = xpRule(t);
  return `de ${x.min} a ${x.max}% do que falta para o próximo nível num feito comum, até ${x.great}% num grande; feito excepcional (só o que as faixas acima não cobrem, como derrotar um vilão principal ou salvar a vila): valor livre, proporcional ao feito, que pode subir mais de um nível`;
};

// descanso: quanto cada recurso recupera (faixa por key do ruleset); sem regra, o Escrivão estima
export const REST_KINDS: { key: RestKind; label: string; when: string }[] = [
  { key: "light", label: "Descanso leve", when: "refeição, pausa" },
  { key: "full", label: "Descanso completo", when: "noite de sono" },
];
export const restRuleText = (t: TableRules) =>
  REST_KINDS.filter((k) => t.rest?.[k.key])
    .map((k) => `${k.label.toLowerCase()} (${k.when}): ${Object.entries(t.rest![k.key]!).map(([r, v]) => `${r} +${v.min}${v.max > v.min ? ` a ${v.max}` : ""}`).join(", ")}`)
    .join("; ");

const preset = (d: Difficulty) => DIFFICULTIES.find((x) => x.key === d) ?? DIFFICULTIES[2];
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");
const offsetOk = (n: number) => Number.isInteger(n) && Math.abs(n) <= 10;

/** "Furtividade Noturna" → "furtividade_noturna" */
export const slugKey = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);

/**
 * Aplica um patch (do PUT ou do Mestre fora do jogo) sobre as regras atuais e valida.
 * categories substitui a lista inteira. Trocar o preset sem dcOffset traz o ajuste do preset.
 * Devolve a regra nova ou a mensagem de erro.
 */
export function normalizeTable(patch: Record<string, unknown>, current: TableRules, resourceKeys: string[] = []): TableRules | string {
  const t: TableRules = { ...current, categories: [...current.categories] };
  if (patch.difficulty !== undefined) {
    const d = DIFFICULTIES.find((x) => x.key === patch.difficulty);
    if (!d) return `difficulty: use ${DIFFICULTIES.map((x) => x.key).join(", ")}`;
    t.difficulty = d.key;
    if (patch.dcOffset === undefined) t.dcOffset = d.dcOffset;
  }
  if (patch.dcOffset !== undefined) {
    const n = Number(patch.dcOffset);
    if (!offsetOk(n)) return "dcOffset: inteiro de -10 a 10";
    t.dcOffset = n;
  }
  if (patch.categories !== undefined) {
    if (!Array.isArray(patch.categories) || patch.categories.length > 12) return "categories: lista de até 12 tipos de ação";
    t.categories = [];
    for (const raw of patch.categories as Record<string, unknown>[]) {
      const label = String(raw?.label ?? "").trim();
      const key = String(raw?.key ?? "").trim().toLowerCase() || slugKey(label);
      const offset = Number(raw?.offset);
      if (!label || label.length > 40) return "categories: cada tipo de ação precisa de label (até 40 caracteres)";
      if (!/^[a-z0-9_-]{1,24}$/.test(key)) return `categories: key inválida em "${label}" (a-z, 0-9, _ e -, até 24)`;
      if (!offsetOk(offset)) return `categories: offset de "${label}" deve ser inteiro de -10 a 10`;
      if (t.categories.some((c) => c.key === key)) return `categories: "${key}" repetida`;
      t.categories.push({ key, label, offset });
    }
  }
  if (patch.crits !== undefined) {
    if (typeof patch.crits !== "boolean") return "crits: true ou false";
    t.crits = patch.crits;
  }
  if (patch.notes !== undefined) {
    const notes = String(patch.notes ?? "").trim();
    if (notes.length > 600) return "notes: até 600 caracteres";
    t.notes = notes || undefined;
  }
  if (patch.modes !== undefined) {
    // parcial vale; texto vazio (ou igual ao padrão) volta ao padrão
    if (!patch.modes || typeof patch.modes !== "object") return "modes: objeto com o texto de cada modo de cena";
    const modes: Partial<Record<SceneMode, string>> = { ...current.modes };
    for (const [k, v] of Object.entries(patch.modes as Record<string, unknown>)) {
      if (!(k in MODE_HINTS)) return `modes: "${k}" não é modo de cena (${Object.keys(MODE_HINTS).join(", ")})`;
      const mode = k as SceneMode;
      const text = String(v ?? "").trim();
      if (text.length > 600) return `modes: o texto de ${mode} vai até 600 caracteres`;
      if (!text || text === MODE_HINTS[mode]) delete modes[mode];
      else modes[mode] = text;
    }
    t.modes = Object.keys(modes).length ? modes : undefined;
  }
  if (patch.xp !== undefined) {
    // parcial vale (o Mestre fora do jogo manda só o que muda)
    const raw = { ...xpRule(current), ...(patch.xp as Record<string, unknown>) };
    const xp = { min: Number(raw.min), max: Number(raw.max), great: Number(raw.great) };
    if (![xp.min, xp.max, xp.great].every((v) => Number.isInteger(v) && v >= 0 && v <= 100) || xp.min > xp.max || xp.max > xp.great)
      return "xp: inteiros de 0 a 100 com min ≤ max ≤ great (% do que falta para o próximo nível)";
    t.xp = xp;
  }
  if (patch.rest !== undefined) {
    // cada tipo de descanso que vier substitui o dele; key que não é recurso do mundo e entrada vazia (null) saem
    if (!patch.rest || typeof patch.rest !== "object") return "rest: objeto { light?, full? } com { min, max } por recurso";
    const rest = { ...current.rest };
    for (const [kind, map] of Object.entries(patch.rest as Record<string, unknown>)) {
      if (!REST_KINDS.some((k) => k.key === kind)) return `rest: "${kind}" não é tipo de descanso (light, full)`;
      const out: Record<string, { min: number; max: number }> = {};
      for (const [key, raw] of Object.entries((map ?? {}) as Record<string, { min?: unknown; max?: unknown } | null>)) {
        if (!resourceKeys.includes(key) || (raw?.min == null && raw?.max == null)) continue;
        const [a, b] = [Number(raw.min ?? raw.max), Number(raw.max ?? raw.min)];
        if (![a, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 999)) return `rest: ${key} precisa de min e max inteiros de 0 a 999`;
        out[key] = { min: Math.min(a, b), max: Math.max(a, b) };
      }
      if (Object.keys(out).length) rest[kind as RestKind] = out;
      else delete rest[kind as RestKind];
    }
    t.rest = Object.keys(rest).length ? rest : undefined;
  }
  return t;
}

/** Cria/muda (por key ou label) e tira tipos de ação; para o Mestre fora do jogo, que não manda a lista inteira. */
export function mergeCategories(
  current: TableRules["categories"],
  set: { key?: string; label?: string; offset?: number }[] = [],
  remove: string[] = []
): Record<string, unknown>[] {
  const same = (c: TableRules["categories"][number], s: string) => c.key === s.toLowerCase() || c.label.toLowerCase() === s.toLowerCase();
  const out: Record<string, unknown>[] = current.filter((c) => !remove.some((r) => same(c, String(r))));
  for (const s of set) {
    const i = out.findIndex((c) => same(c as TableRules["categories"][number], String(s.key || s.label || "")));
    if (i >= 0) out[i] = { ...out[i], offset: s.offset };
    else out.push({ key: s.key, label: s.label, offset: s.offset });
  }
  return out;
}

/**
 * CD efetiva = CD do Mestre + ajuste da mesa + ajuste do tipo de ação (mínimo 1).
 * dice vai junto do DiceResult (a UI mostra "CD 15 +2 Difícil = 17"); note vai no texto para o Mestre.
 */
export function tableDc(
  t: TableRules,
  dc: number | undefined,
  category: unknown
): { dc?: number; dice: Pick<DiceResult, "baseDc" | "dcAdjust">; note: string } {
  const asked = category ? String(category) : "";
  const cat = asked ? t.categories.find((c) => c.key === asked.toLowerCase() || c.label.toLowerCase() === asked.toLowerCase()) : undefined;
  const unknown =
    asked && !cat
      ? ` Tipo de ação "${asked}" não existe nas regras da mesa (${t.categories.map((c) => c.key).join(", ") || "nenhum"}): sem ajuste por tipo.`
      : "";
  if (dc === undefined || !Number.isFinite(dc)) return { dice: {}, note: unknown };
  const dcAdjust = [
    { label: preset(t.difficulty).label, value: t.dcOffset },
    ...(cat ? [{ label: cat.label, value: cat.offset }] : []),
  ].filter((a) => a.value);
  if (!dcAdjust.length) return { dc, dice: {}, note: unknown };
  const eff = Math.max(1, dc + dcAdjust.reduce((s, a) => s + a.value, 0));
  return {
    dc: eff,
    dice: { baseDc: dc, dcAdjust },
    note: ` (CD base ${dc} ${dcAdjust.map((a) => `${signed(a.value)} ${a.label}`).join(" ")} = ${eff}; ajuste da mesa já aplicado, não compense)${unknown}`,
  };
}

/** " contra CD 17 (base 15 +2 Difícil...): SUCESSO (20 natural)" para o texto da ferramenta. */
export function dcResultText(r: DiceResult, note: string): string {
  if (r.dc === undefined) return note;
  const crit = r.crit === "success" ? " (20 natural: passa sempre)" : r.crit === "failure" ? " (1 natural: falha sempre)" : "";
  const sure = r.sure ? (r.success ? " (garantido: passaria com qualquer resultado do dado)" : " (garantido: nenhum resultado do dado alcançaria)") : "";
  return ` contra CD ${r.dc}${note}: ${r.success ? "SUCESSO" : "FALHA"}${crit}${sure}`;
}

/** Resumo curto para confirmações: "Difícil (CD +2) · Combate +3 · críticos ligados". */
export function tableSummary(t: TableRules): string {
  return [
    `${preset(t.difficulty).label} (CD ${signed(t.dcOffset)})`,
    t.categories.length ? t.categories.map((c) => `${c.label} ${signed(c.offset)}`).join(", ") : "",
    `críticos ${t.crits ? "ligados" : "desligados"}`,
    `XP ${xpRule(t).min}–${xpRule(t).max}% por feito (grande até ${xpRule(t).great}%)`,
    t.rest ? `descanso: ${restRuleText(t)}` : "",
    t.modes ? `modos ajustados: ${(Object.keys(t.modes) as SceneMode[]).map((k) => MODE_LABELS[k]).join(", ")}` : "",
    t.notes ? `nota: ${t.notes}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Bloco REGRAS DA MESA do prompt do Mestre (turno e fora do jogo). */
export function tablePromptBlock(t: TableRules): string {
  const p = preset(t.difficulty);
  return [
    `\n--- REGRAS DA MESA (o jogador ajusta) ---`,
    `Escala de CD: a de "Rolagens" na MECÂNICA, se houver; senão trivial 5, fácil 10, médio 15, difícil 20, muito difícil 25, quase impossível 30. Escolha a CD pela ficção: o servidor soma os ajustes abaixo e o resultado mostra a CD base e a efetiva. Não compense.`,
    `Dificuldade: ${p.label} (CD ${signed(t.dcOffset)}): ${p.tone}`,
    t.categories.length
      ? `Ajuste por tipo de ação (informe category em roll_dice/use_ability): ${t.categories.map((c) => `${c.key} (${c.label}) ${signed(c.offset)}`).join("; ")}`
      : "",
    t.crits ? "Críticos: 20 natural passa e 1 natural falha (1d20 com CD)." : "Críticos: desligados (só o total conta).",
    t.notes ? `Orientação do jogador sobre dificuldade: ${t.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

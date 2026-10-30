// Regras da mesa (campaign.state.table): dificuldade e dados ajustáveis durante a campanha.
// Puro (sem banco): serve ao servidor e à UI.
import type { DiceResult, Difficulty, TableRules } from "./types";

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
export function normalizeTable(patch: Record<string, unknown>, current: TableRules): TableRules | string {
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
  return ` contra CD ${r.dc}${note}: ${r.success ? "SUCESSO" : "FALHA"}${crit}`;
}

/** Resumo curto para confirmações: "Difícil (CD +2) · Combate +3 · críticos ligados". */
export function tableSummary(t: TableRules): string {
  return [
    `${preset(t.difficulty).label} (CD ${signed(t.dcOffset)})`,
    t.categories.length ? t.categories.map((c) => `${c.label} ${signed(c.offset)}`).join(", ") : "",
    `críticos ${t.crits ? "ligados" : "desligados"}`,
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

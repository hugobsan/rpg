/**
 * Criador de aventuras (client-safe, sem banco): a resposta do agente vem em texto + um bloco
 * ```json {"patch", "choices", "done"}```. Aqui ficam o parse dessa resposta, o merge do patch no
 * rascunho do ruleset, a validação final (o que quebraria uma campanha) e o progresso em linguagem natural.
 */
import type { Ruleset } from "./types";
import { THEMES } from "./theme";
import { costsByRankText } from "./ruleset";

/** Rascunho: ruleset parcial + startingPoint (sugestão para o campo do assistente; viaja no JSON). */
export type Draft = Partial<Ruleset>;

export interface DraftMessage {
  role: "user" | "assistant";
  content: string;
  choices?: string[];
}

export interface Reply {
  message: string;
  patch: Draft;
  choices: string[];
  done: boolean;
  /** veio um bloco de estado, mas ilegível (o patch se perdeu) */
  broken: boolean;
}

export const OPENING: DraftMessage = {
  role: "assistant",
  content:
    "Vamos criar a sua aventura. Sobre o que ela é? Pode ser uma obra que você curte (livro, anime, filme, jogo) ou um mundo original. Uma frase já basta: eu cuido das regras e só pergunto o que fizer diferença.",
  choices: ["Harry Potter", "Piratas em busca de um tesouro", "Faroeste sobrenatural", "Ficção científica no espaço"],
};

/** Pedido do botão "Finalizar agora". */
export const FINISH_TEXT = "Pode fechar a aventura com o que já temos. Decida você o que faltar.";

// campos de topo que o patch pode mexer (o resto é ignorado)
const KEYS: (keyof Ruleset)[] = [
  "name", "description", "theme", "loreNotes", "canonBased", "startingPoint", "attributes", "resources",
  "abilityTypes", "abilityRanks", "ranks", "powerLevels", "masteryBonus", "masteryCost", "xpPerAttributePoint",
  "attributeMultiplier", "abilityAttributes", "training", "creationPoints", "extraFields", "diceNotes",
  "progressionNotes", "abilitiesLabel", "abilityCosts", "startingAbilities",
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// consertos baratos de JSON de modelo: vírgula sobrando, quebra de linha crua dentro de texto e
// chave fechando a mais (tira o último } ou ] antes do ponto do erro, até 3 vezes)
function parseObj(text: string): Record<string, unknown> | null {
  const noComma = text.replace(/,(\s*[}\]])/g, "$1");
  for (const t of [text, noComma]) {
    try {
      const v = JSON.parse(t);
      if (isObj(v)) return v;
    } catch {}
  }
  let t = noComma.replace(/\r?\n/g, " ");
  for (let i = 0; i < 4; i++) {
    try {
      const v = JSON.parse(t);
      return isObj(v) ? v : null;
    } catch (e) {
      const at = Number(/position (\d+)/.exec(String(e))?.[1] ?? NaN);
      const cut = Number.isNaN(at) ? -1 : Math.max(t.lastIndexOf("}", at - 1), t.lastIndexOf("]", at - 1));
      if (cut < 0) return null;
      t = t.slice(0, cut) + t.slice(cut + 1);
    }
  }
  return null;
}

/** Separa o texto para o jogador do bloco de estado. Bloco ilegível = patch vazio (o texto sobrevive). */
export function parseReply(raw: string): Reply {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let state: Record<string, unknown> | null = null;
  let broken = false;
  // último bloco cercado (```json ... ```) que vire objeto; sem cerca, o último {"patch" ... } do texto
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const m of fences.reverse()) {
    const obj = parseObj(m[1].trim());
    if (obj && ("patch" in obj || "done" in obj || "choices" in obj)) {
      state = obj;
      text = text.replace(m[0], "");
      break;
    }
  }
  if (!state) {
    const i = text.search(/\{\s*"(patch|choices|done)"/);
    if (i >= 0) {
      state = parseObj(text.slice(i, text.lastIndexOf("}") + 1));
      broken = !state;
      text = text.slice(0, i).replace(/```\w*\s*$/, ""); // mesmo ilegível, JSON não vai para o jogador
    }
  }
  const patch = isObj(state?.patch) ? (state.patch as Draft) : {};
  const choices = Array.isArray(state?.choices)
    ? state.choices.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim().slice(0, 120)).slice(0, 5)
    : [];
  return { message: text.replace(/```\w*\s*```/g, "").trim(), patch, choices, done: state?.done === true, broken };
}

/** Cada campo do patch troca o campo inteiro; null apaga. Campos desconhecidos são ignorados. */
export function mergeDraft(draft: Draft, patch: Draft): Draft {
  const next: Record<string, unknown> = { ...draft };
  for (const [k, v] of Object.entries(patch)) {
    if (!KEYS.includes(k as keyof Ruleset)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as Draft;
}

const SLUG = /^[a-z][a-z0-9_]*$/;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown) => typeof v === "string" && !!v.trim();

/** Lista de chaves: cada item com key slug única e label. */
function keyed(list: unknown, what: string, out: string[]): string[] {
  if (!Array.isArray(list) || !list.length) {
    out.push(`${what}: falta definir`);
    return [];
  }
  const keys: string[] = [];
  for (const it of list) {
    const k = isObj(it) ? it.key : undefined;
    if (typeof k !== "string" || !SLUG.test(k)) out.push(`${what}: key inválida ${JSON.stringify(k)} (minúsculas, sem acento, snake_case)`);
    else if (keys.includes(k)) out.push(`${what}: key repetida "${k}"`);
    else keys.push(k);
    if (!isObj(it) || !str(it.label)) out.push(`${what}: item sem label (${String(k)})`);
  }
  return keys;
}

/** O que impede (ou estragaria) uma campanha com este rascunho. Vazio = pronto. */
export function draftIssues(d: Draft): string[] {
  const out: string[] = [];
  for (const k of ["name", "description", "loreNotes", "diceNotes"] as const) if (!str(d[k])) out.push(`${k}: falta definir`);
  if (!THEMES.some((t) => t.key === d.theme)) out.push(`theme: use uma das chaves ${THEMES.map((t) => t.key).join(", ")}`);
  const attrs = keyed(d.attributes, "attributes", out);
  for (const a of d.attributes || [])
    if (!num(a.min) || !num(a.max) || !num(a.default) || a.min > a.default || a.default > a.max)
      out.push(`attributes.${a.key}: precisa de min <= default <= max (números)`);
  const res = keyed(d.resources, "resources", out);
  for (const r of d.resources || []) {
    if (!num(r.defaultMax) || r.defaultMax <= 0) out.push(`resources.${r.key}: defaultMax precisa ser > 0`);
    if (!/^#[0-9a-f]{6}$/i.test(r.color || "")) out.push(`resources.${r.key}: color em #rrggbb`);
  }
  const types = keyed(d.abilityTypes, "abilityTypes", out);
  const ranks = Array.isArray(d.abilityRanks) && d.abilityRanks.every(str) ? d.abilityRanks : [];
  if (!ranks.length) out.push("abilityRanks: falta definir (lista de textos, do mais fraco ao mais forte)");
  for (const [field, list] of [["ranks", d.ranks], ["powerLevels", d.powerLevels]] as const) {
    keyed(list, field, out);
    const xp = (list || []).map((x) => x.xpRequired);
    if (xp.length && (xp[0] !== 0 || xp.some((v, i) => !num(v) || (i > 0 && v <= xp[i - 1]))))
      out.push(`${field}: xpRequired começa em 0 e sobe a cada item`);
  }
  for (const p of d.powerLevels || [])
    if (p.attributeCap !== undefined && !num(p.attributeCap)) out.push(`powerLevels.${p.key}: attributeCap precisa ser número`);
  const cargos = (d.ranks || []).map((r) => r.key);
  if (!num(d.creationPoints) || d.creationPoints! < 0) out.push("creationPoints: falta definir (número)");
  if (!num(d.attributeMultiplier) || d.attributeMultiplier! <= 0) out.push("attributeMultiplier: falta definir (número > 0)");
  if (d.xpPerAttributePoint !== undefined && (!num(d.xpPerAttributePoint) || d.xpPerAttributePoint <= 0))
    out.push("xpPerAttributePoint: número > 0");
  keyed(d.extraFields, "extraFields", out);
  const ac = d.abilityCosts;
  if (!isObj(ac) || !res.includes(ac.resource) || !isObj(ac.byRank)) out.push(`abilityCosts: {resource: uma de ${res.join(", ") || "resources"}, byRank: {rank: custo}}`);
  else for (const [k, v] of Object.entries(ac.byRank)) if (!ranks.includes(k) || !num(v)) out.push(`abilityCosts.byRank: "${k}" não é um abilityRank ou o custo não é número`);
  // todo tipo de habilidade testa algum atributo (sem isso, cai no primeiro atributo da lista)
  for (const t of types) {
    const mapped = d.abilityAttributes?.[t];
    if (mapped ? !attrs.includes(mapped) : !attrs.includes(t)) out.push(`abilityAttributes: tipo "${t}" sem atributo de teste válido`);
  }
  // kit: o primeiro cargo tem kit; cada habilidade com tipo, rank e custo que existem
  if (cargos[0] && !(d.startingAbilities?.[cargos[0]]?.length)) out.push(`startingAbilities: falta o kit do primeiro cargo "${cargos[0]}"`);
  for (const [k, list] of Object.entries(d.startingAbilities || {})) {
    if (!cargos.includes(k)) out.push(`startingAbilities: "${k}" não é key de ranks`);
    for (const a of Array.isArray(list) ? list : []) {
      const n = a?.name || "?";
      if (!str(a?.name)) out.push(`startingAbilities.${k}: habilidade sem name`);
      if (!types.includes(a?.type)) out.push(`startingAbilities.${k}.${n}: type "${a?.type}" não está em abilityTypes`);
      if (a?.rank !== undefined && !ranks.includes(a.rank)) out.push(`startingAbilities.${k}.${n}: rank "${a.rank}" não está em abilityRanks`);
      if (a?.cost && (!res.includes(a.cost.resource) || !num(a.cost.amount))) out.push(`startingAbilities.${k}.${n}: cost {resource de resources, amount número}`);
    }
  }
  for (const f of ["masteryBonus", "masteryCost"] as const) {
    const b = d[f];
    if (b !== undefined && (!Array.isArray(b) || !b.every((x) => num(x?.min) && num(x?.value)))) out.push(`${f}: lista de {min, value} ou omita`);
  }
  if (d.training !== undefined && !isObj(d.training)) out.push("training: objeto ou omita");
  return out;
}

const names = (list?: { label: string }[]) => (list || []).map((x) => x.label).join(", ");
const firstSentence = (t?: string) => (t ? t.split(/(?<=[.!?])\s/)[0].slice(0, 160) : "");

/** O que já está definido, em linguagem natural (null = a definir), na ordem da entrevista. */
export function draftProgress(d: Draft): { label: string; value: string | null }[] {
  const kitCount = Object.values(d.startingAbilities || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  const ab = d.abilitiesLabel || "Habilidades";
  const res = d.resources?.find((r) => r.key === d.abilityCosts?.resource)?.label;
  return [
    { label: "Aventura", value: d.name ? `${d.name}${d.canonBased ? ", segue a obra" : ""}` : null },
    { label: "Mundo e tom", value: firstSentence(d.loreNotes || d.description) || null },
    { label: "Ponto de partida", value: d.startingPoint || null },
    { label: "Atributos", value: names(d.attributes) || null },
    { label: "Barras", value: names(d.resources) || null },
    { label: ab, value: d.abilityTypes?.length ? `${names(d.abilityTypes)}${d.abilityRanks?.length ? ` · níveis ${d.abilityRanks.join(" < ")}` : ""}` : null },
    { label: "Custo", value: d.abilityCosts && res ? `${res} por nível: ${costsByRankText({ ...d, abilityRanks: d.abilityRanks || [] } as Ruleset).replace(/=/g, " ")}` : null },
    { label: "Cargos", value: d.ranks?.length ? d.ranks.map((r) => r.label).join(" → ") : null },
    { label: "Níveis de poder", value: d.powerLevels?.length ? d.powerLevels.map((p) => p.label).join(" → ") : null },
    { label: "Kit inicial", value: kitCount ? `${kitCount} ${kitCount === 1 ? "habilidade" : "habilidades"}` : null },
    { label: "Ficha", value: names(d.extraFields) || null },
    { label: "Rolagens", value: firstSentence(d.diceNotes) || null },
    { label: "Tema visual", value: THEMES.find((t) => t.key === d.theme)?.label || null },
  ];
}

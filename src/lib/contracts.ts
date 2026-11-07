/**
 * Contratos do turno, sem banco e sem IA: o bloco ```efeitos do Narrador (e do Anotador), a saída do Intérprete, o
 * resultado do Resolvedor e o validador de prosa. Parse tolerante (cerca, vírgula sobrando, aspas curvas) e validação à
 * mão, campo a campo: o que estiver inválido sai sozinho, nunca o bloco inteiro por causa de um campo.
 * Verificação sem IA: npx tsx scripts/eval-check.ts
 */

// ---------- enums ----------

export const APPROACHES = ["force", "finesse", "talk", "sense", "move", "wait", "exit"] as const;
export type Approach = (typeof APPROACHES)[number];
// faixa de tempo → minutos somados ao relógio; nextmorning vai às 7h do dia seguinte
export const TIME_SPANS = { none: 0, minutes: 5, quarter: 15, hour: 60, hours: 180, halfday: 480, nextmorning: -1 } as const;
export type TimeSpan = keyof typeof TIME_SPANS;
export const REST_KINDS = ["none", "light", "full"] as const;
export const MISSION_OPS = ["none", "offer", "accept", "complete", "fail"] as const;
export type MissionOp = (typeof MISSION_OPS)[number];
export const STEP_KINDS = ["ability", "attribute", "item", "train", "talk", "move", "wait", "other"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "very_hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const LIKELIHOODS = ["impossible", "very_unlikely", "unlikely", "even", "likely", "very_likely", "certain"] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];

// ---------- bloco de efeitos ----------

export interface OptionStep {
  ability?: string;
  item?: string;
  target?: string;
}
export interface EffectOption {
  label: string;
  approach: Approach;
  steps: OptionStep[];
}
export interface Effects {
  options: EffectOption[];
  time: TimeSpan;
  scene: { newScene: boolean; location: string; present: string[] | null }; // present null = não informou
  newNpcs: { name: string; gender: "m" | "f" | "?"; brief: string }[];
  facts: { text: string; public: boolean }[];
  told: { fact: string; by: string; to: string[] }[];
  items: { name: string; qty: number }[];
  purchase: { item: string; qty: number; price: number } | null;
  rest: (typeof REST_KINDS)[number];
  mission: { op: Exclude<MissionOp, "none">; id: string; title?: string; pay?: number; size?: string } | null;
  beat: { op: "advance" | "done"; id: string } | null; // o beat em jogo do cartão andou ou aconteceu (id completo)
}

export const emptyEffects = (): Effects => ({
  options: [],
  time: "none",
  scene: { newScene: false, location: "", present: null },
  newNpcs: [],
  facts: [],
  told: [],
  items: [],
  purchase: null,
  rest: "none",
  mission: null,
  beat: null,
});

/** O que o validador precisa saber da campanha (montado pelo engine). */
export interface EffectsCtx {
  player: string; // nome do personagem do jogador (vale em told.by/to)
  abilities: string[]; // técnicas da ficha (nome e tradução)
  items: string[]; // inventário
  npcs: string[]; // NPCs registrados
  missions: { id: string; title: string; status: string }[];
  money: number | null; // saldo; null = mundo sem dinheiro
  resourceWords: string[]; // keys e rótulos dos recursos (validador de prosa nos fatos)
  activeBeat?: string | null; // id do beat em jogo (lib/story.ts); o "beat" do bloco só vale para ele
  location?: string; // local da cena antes do turno (NPC genérico ganha o local no nome)
}

// ---------- nomes ----------

/** Sem acento nem caixa, só letras e números. */
export const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// 1º nome sem honorífico: "Iruka-sensei" = "Iruka Umino"
const firstKey = (s: string) => fold(s.replace(/\(.*?\)/g, "").replace(/-(sensei|sama|kun|chan|san|dono|senpai|hime)\b/gi, "")).split(" ")[0] || "";

/** O nome da lista a que `said` se refere (exato sem acento, ou o 1º nome); undefined = nenhum. */
export function matchName(list: string[], said: string): string | undefined {
  const f = fold(said);
  if (!f) return undefined;
  return list.find((n) => fold(n) === f) ?? list.find((n) => firstKey(n) === firstKey(said) || fold(n).split(" ").includes(f));
}

// NPC genérico (função, não nome): um por lugar, com o local no nome ("Lojista (Loja de armas)"), para duas lojas não
// dividirem o mesmo NPC e o que ele sabe
const GENERIC_NPC = /^(o |a )?(lojista|vendedora?|recepcionista|atendente|balconista|caixeiro|guarda|sentinela|porteiro|taberneir[oa]|garcom|garconete|cozinheir[oa]|ferreiro|mercador|comerciante|don[oa] da loja|estalajadeir[oa]|enfermeir[oa]|medic[oa])$/;
const baseGeneric = (name: string) => GENERIC_NPC.test(fold(name.replace(/\(.*?\)/g, "")));
export const isGenericName = (name: string) => !name.includes("(") && baseGeneric(name);
export const localName = (name: string, location?: string) =>
  isGenericName(name) && location?.trim() ? `${name.trim()} (${location.trim().slice(0, 50)})` : name.trim();
/** matchName, mas nome genérico só casa com o NPC daquele lugar (ou com o nome já com o local), nunca pelo 1º nome. */
export function resolveName(list: string[], said: string, location?: string): string | undefined {
  if (!baseGeneric(said)) return matchName(list, said);
  const f = fold(localName(said, location));
  return list.find((n) => fold(n) === f);
}

/**
 * Técnica ou item pelo nome dito: exato sem acento, a parte depois de ":" ("Gōkakyū no Jutsu" = "Katon: Gōkakyū no
 * Jutsu"), ou o único da lista que contém o que foi dito. Sem 1º nome: "Katon: X" e "Katon: Y" não se confundem.
 */
export function matchThing(list: string[], said: string): string | undefined {
  const f = fold(said);
  if (!f) return undefined;
  const exact = list.find((n) => fold(n) === f || fold(n.split(":").pop()!) === f);
  if (exact) return exact;
  const inside = list.filter((n) => ` ${fold(n)} `.includes(` ${f} `));
  return inside.length === 1 ? inside[0] : undefined;
}

// ---------- parse tolerante ----------

const FENCE = /```\s*(efeitos|effects|json|choices)?\s*\n?([\s\S]*?)(```|$)/i;

/**
 * Prosa e bloco: a prosa é tudo antes da 1ª cerca ```efeitos/```json/```choices (ou de um JSON solto no fim que comece
 * com uma chave conhecida); block = o texto do bloco (null = não veio). Um ```choices antigo vira { options } só com rótulos.
 */
export function splitNarration(text: string): { prose: string; block: string | null } {
  const m = text.match(FENCE);
  if (m && m.index !== undefined) {
    const kind = (m[1] || "").toLowerCase();
    const body = m[2].trim();
    return { prose: text.slice(0, m.index).trim(), block: kind === "choices" ? `{"options": ${body || "[]"}}` : body || null };
  }
  // JSON solto no fim, sem cerca
  const i = text.search(/\{\s*"(options|time|scene|facts|items|mission)"/);
  if (i >= 0 && parseLooseJson(text.slice(i))) return { prose: text.slice(0, i).trim(), block: text.slice(i).trim() };
  return { prose: text.trim(), block: null };
}

/** JSON com os defeitos comuns de modelo: cerca, texto em volta, vírgula sobrando, aspas curvas, comentário. null = ilegível. */
export function parseLooseJson(raw: string): unknown {
  let t = raw.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  const tries = [
    t,
    t
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const s of tries) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* tenta a próxima */
    }
  }
  return null;
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const oneOf = <T extends readonly string[]>(list: T, v: unknown): T[number] | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T[number]) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Valida o bloco campo a campo. dropped = o que saiu e por quê (vai para o log e para a nova tentativa).
 * Técnica e item dos passos precisam estar na ficha; alvo e present, ser NPC registrado ou novo; fatos sem número de
 * mecânica; missão existente; compra até o saldo.
 */
export function validateEffects(raw: unknown, ctx: EffectsCtx): { effects: Effects; dropped: string[] } {
  const r = obj(raw);
  const fx = emptyEffects();
  const dropped: string[] = [];
  const drop = (why: string) => dropped.push(why);

  // NPCs novos primeiro: valem como alvo e present. Genérico ganha o local de onde a cena termina
  const loc = str(obj(r.scene).location, 80) || ctx.location;
  const who = (list: string[], said: string) => resolveName(list, said, loc);
  for (const n of arr(r.newNpcs).slice(0, 4)) {
    const o = obj(n);
    const name = localName(str(o.name, 40), loc);
    if (!name) continue;
    if (who(ctx.npcs, name) || fold(name) === fold(ctx.player)) continue; // já registrado: não é novo
    const g = str(o.gender, 1).toLowerCase();
    fx.newNpcs.push({ name, gender: g === "m" || g === "f" ? g : "?", brief: words(str(o.brief, 400), 30) });
  }
  const people = [...ctx.npcs, ...fx.newNpcs.map((n) => n.name)];

  for (const raw of arr(r.options).slice(0, 4)) {
    const o = typeof raw === "string" ? { label: raw } : obj(raw);
    const label = words(str(o.label, 160), 12);
    if (!label) continue;
    let approach = oneOf(APPROACHES, o.approach);
    if (!approach) {
      if (o.approach !== undefined) drop(`approach inválido em "${label}"`);
      approach = "finesse";
    }
    const steps: OptionStep[] = [];
    for (const s of arr(o.steps).slice(0, 3)) {
      const so = obj(s);
      const step: OptionStep = {};
      if (so.ability) {
        const a = matchThing(ctx.abilities, str(so.ability, 80));
        if (!a) {
          drop(`técnica fora da ficha: ${str(so.ability, 80)}`);
          continue; // passo descartado
        }
        step.ability = a;
      }
      if (so.item) {
        const it = matchThing(ctx.items, str(so.item, 80));
        if (!it) {
          drop(`item fora do inventário: ${str(so.item, 80)}`);
          continue;
        }
        step.item = it;
      }
      if (so.target) {
        const t = who(people, str(so.target, 60));
        if (t) step.target = t;
        else drop(`alvo desconhecido: ${str(so.target, 60)}`);
      }
      if (step.ability || step.item || step.target) steps.push(step);
    }
    fx.options.push({ label, approach, steps });
  }

  const time = oneOf(Object.keys(TIME_SPANS) as TimeSpan[], r.time);
  if (time) fx.time = time;
  else if (r.time !== undefined) drop(`time inválido: ${String(r.time)}`);

  const sc = obj(r.scene);
  fx.scene.newScene = sc.newScene === true;
  fx.scene.location = str(sc.location, 80);
  if (Array.isArray(sc.present)) {
    fx.scene.present = [];
    for (const p of sc.present) {
      const n = who(people, str(p, 60));
      if (n) fx.scene.present.includes(n) || fx.scene.present.push(n);
      else if (str(p, 60) && fold(str(p, 60)) !== fold(ctx.player) && !matchName([ctx.player], str(p, 60))) drop(`present desconhecido: ${str(p, 60)}`);
    }
  }

  for (const f of arr(r.facts).slice(0, 3)) {
    const o = typeof f === "string" ? { text: f } : obj(f);
    const text = words(str(o.text, 300), 25);
    if (!text) continue;
    if (proseIssues(text, ctx.resourceWords).length) drop(`fato com número de mecânica: ${text}`);
    else fx.facts.push({ text, public: o.public === true });
  }

  const known = [...people, ctx.player];
  for (const t of arr(r.told).slice(0, 3)) {
    const o = obj(t);
    const fact = words(str(o.fact, 300), 25);
    const by = who(known, str(o.by, 60));
    const to = arr(o.to).map((x) => who(known, str(x, 60))).filter((x): x is string => !!x && x !== by);
    if (!fact || !by || !to.length) {
      if (fact) drop(`told sem quem contou ou para quem: ${fact}`);
      continue;
    }
    if (proseIssues(fact, ctx.resourceWords).length) drop(`told com número de mecânica: ${fact}`);
    else fx.told.push({ fact, by, to: [...new Set(to)] });
  }

  for (const it of arr(r.items).slice(0, 6)) {
    const o = obj(it);
    const name = str(o.name, 80);
    const qty = Math.round(Number(o.qty ?? 1));
    if (!name || !Number.isFinite(qty) || !qty || Math.abs(qty) > 99) continue;
    if (qty < 0) {
      const have = matchThing(ctx.items, name);
      if (!have) drop(`perdeu item que não tem: ${name}`);
      else fx.items.push({ name: have, qty });
    } else fx.items.push({ name: matchThing(ctx.items, name) ?? name, qty });
  }

  const pu = obj(r.purchase);
  if (str(pu.item, 80)) {
    const qty = Math.max(1, Math.round(Number(pu.qty ?? 1)) || 1);
    const price = Math.round(Number(pu.price));
    if (ctx.money === null) drop("compra num mundo sem dinheiro");
    else if (!(price >= 0)) drop(`compra sem preço: ${str(pu.item, 80)}`);
    else if (price > ctx.money) drop(`compra acima do saldo: ${str(pu.item, 80)} por ${price}`);
    else fx.purchase = { item: str(pu.item, 80), qty, price };
  }

  const rest = oneOf(REST_KINDS, r.rest);
  if (rest) fx.rest = rest;

  const mi = obj(r.mission);
  const op = oneOf(MISSION_OPS, mi.op);
  if (op === "offer") {
    const title = str(mi.title, 80);
    if (!title) drop("missão oferecida sem título");
    else {
      const pay = Math.round(Number(mi.pay));
      const size = oneOf(["pequena", "media", "grande"] as const, mi.size);
      fx.mission = { op, id: "", title, ...(pay > 0 && { pay }), size: size ?? "pequena" };
    }
  } else if (op && op !== "none") {
    const id = str(mi.id, 80);
    const m = ctx.missions.find((x) => x.id.toLowerCase() === id.toLowerCase()) ?? ctx.missions.find((x) => fold(x.title) === fold(id));
    if (!m) drop(`missão desconhecida: ${id || "(sem id)"}`);
    else fx.mission = { op, id: m.id };
  }

  const be = obj(r.beat);
  const bop = oneOf(["none", "advance", "done"] as const, be.op);
  if (bop && bop !== "none") {
    const id = str(be.id, 40);
    if (ctx.activeBeat && id.length >= 8 && ctx.activeBeat.startsWith(id.slice(0, 8))) fx.beat = { op: bop, id: ctx.activeBeat };
    else drop(`beat fora do cartão: ${id || "(sem id)"}`);
  }

  return { effects: fx, dropped };
}

// ---------- validador de prosa ----------

const NUM =
  "um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|\\d+";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Trechos da prosa com número ou termo de mecânica (o que o Narrador nunca escreve). Pega "x/y", %, CD, rodada, dado,
 * XP, "N pontos", "custa um ponto", "ponto(s) de <recurso>" e "N de <recurso>" pelas keys e rótulos do ruleset.
 * Não pega hora ("às sete e meia"), preço, distância nem quantidade de coisas ("três clones"). [] = limpa.
 */
export function proseIssues(text: string, resourceWords: string[]): string[] {
  const res = [...new Set(resourceWords.map((w) => w.trim()).filter((w) => w.length > 1))].map(esc).join("|");
  const patterns = [
    /\b\d+\s*\/\s*\d+\b/g,
    /\d+(?:[.,]\d+)?\s*%|\bpor cento\b/gi,
    /\bCDs?\b/g,
    /\brodadas?\b/gi,
    /\b\d*d(?:4|6|8|10|12|20|100)\b/g,
    /\b\d+\s*XP\b|\bXP\b|\bpontos? de experi[eê]ncia\b/gi,
    new RegExp(`(?<![\\p{L}])(?:${NUM})\\s+pontos\\b`, "giu"),
    /\b(?:custa|custam|custou|gasta|gastam|gastou|consome|consomem|recupera|recuperam|perde|perdeu|ganha|ganhou)\s+(?:\S+\s+){0,2}pontos?\b/gi,
    ...(res
      ? [
          new RegExp(`\\bpontos?\\s+de\\s+(?:${res})(?![\\p{L}])`, "giu"),
          // "quinze de chakra", "15 de chakra", "15 chakra" (por extenso só com "de": "uma vida inteira" passa)
          new RegExp(`(?<![\\p{L}])(?:${NUM})\\s+de\\s+(?:${res})(?![\\p{L}])`, "giu"),
          new RegExp(`(?<![\\p{L}\\d])\\d+\\s+(?:${res})(?![\\p{L}])`, "giu"),
        ]
      : []),
  ];
  const out: string[] = [];
  for (const p of patterns) for (const m of text.matchAll(p)) out.push(m[0].trim());
  return [...new Set(out)];
}

// ---------- Intérprete ----------

export interface InterpStep {
  kind: StepKind;
  ability?: string;
  attribute?: string;
  item?: string;
  target?: string;
  hours?: number;
  intent: string;
  difficulty: Difficulty;
}
export interface Interpretation {
  steps: InterpStep[];
  declaresOutcome: boolean;
  question?: { text: string; likelihood: Likelihood };
}

/** Fallback do Intérprete: um passo `other` médio com a ação inteira. */
export const fallbackInterpretation = (action: string): Interpretation => ({
  steps: [{ kind: "other", intent: words(action, 15), difficulty: "medium" }],
  declaresOutcome: false,
});

/**
 * Valida a saída do Intérprete. Técnica fora da ficha fica (o Resolvedor limita a parcial); atributo fora da lista e
 * item fora do inventário saem do passo. null = nada aproveitável (o chamador tenta de novo ou usa o fallback).
 */
export function validateInterpretation(
  raw: unknown,
  ctx: { abilities: string[]; attributes: string[]; items: string[]; npcs: string[] }
): Interpretation | null {
  const r = obj(raw);
  const steps: InterpStep[] = [];
  for (const s of arr(r.steps).slice(0, 3)) {
    const o = obj(s);
    const kind = oneOf(STEP_KINDS, o.kind) ?? "other";
    const step: InterpStep = { kind, intent: words(str(o.intent, 200), 15) || kind, difficulty: oneOf(DIFFICULTIES, o.difficulty) ?? "medium" };
    if (str(o.ability, 80)) step.ability = matchThing(ctx.abilities, str(o.ability, 80)) ?? str(o.ability, 80);
    if (str(o.attribute, 40)) step.attribute = matchThing(ctx.attributes, str(o.attribute, 40));
    if (str(o.item, 80)) step.item = matchThing(ctx.items, str(o.item, 80));
    if (str(o.target, 60)) step.target = matchName(ctx.npcs, str(o.target, 60));
    const h = Math.round(Number(o.hours));
    if (kind === "train") step.hours = h >= 1 && h <= 12 ? h : 2;
    if (kind === "ability" && !step.ability) step.kind = "attribute";
    if (kind === "item" && !step.item) step.kind = "other";
    steps.push(step);
  }
  if (!steps.length) return null;
  const qo = obj(r.question);
  const likelihood = oneOf(LIKELIHOODS, qo.likelihood);
  return {
    steps,
    declaresOutcome: r.declaresOutcome === true,
    ...(str(qo.text) && likelihood && { question: { text: str(qo.text), likelihood } }),
  };
}

/** Passos tipados de uma opção escolhida (sem Intérprete). */
export function optionSteps(o: EffectOption): InterpStep[] {
  const difficulty: Difficulty = o.approach === "force" ? "hard" : "medium";
  const steps: InterpStep[] = o.steps.map((s) =>
    s.ability
      ? { kind: "ability", ability: s.ability, target: s.target, intent: o.label, difficulty }
      : s.item
        ? { kind: "item", item: s.item, target: s.target, intent: o.label, difficulty }
        : { kind: o.approach === "talk" ? "talk" : "attribute", target: s.target, intent: o.label, difficulty }
  );
  if (steps.length) return steps;
  const easy = ["talk", "move", "wait", "exit"].includes(o.approach);
  return [{ kind: easy ? (o.approach === "talk" ? "talk" : o.approach === "wait" ? "wait" : "move") : "attribute", intent: o.label, difficulty: easy ? "trivial" : o.approach === "sense" ? "easy" : difficulty }];
}

// ---------- Resolvedor ----------

export type Outcome = "crit" | "success" | "partial" | "fail";
export type ResourceLevel = "full" | "steady" | "low" | "empty";
export interface StepResult {
  intent: string;
  result: Outcome;
  perceived: string;
  cost: "none" | "light" | "heavy";
  resource: ResourceLevel | null; // nível do recurso tocado, depois do passo
  resourceLabel?: string;
  note?: string; // em palavras, para o Narrador
  fact?: string; // marco que a cena viu (domínio da técnica subiu de faixa): vira fato com testemunhas
}

// tabela única de dificuldade: base + 4 por ponto de multiplicador acima de 1 (Naruto ×2: 10/14/18/22/26)
const DC_BASE: Record<Difficulty, number> = { trivial: 6, easy: 10, medium: 14, hard: 18, very_hard: 22 };
export const dcFor = (d: Difficulty, mult = 1) => DC_BASE[d] + Math.round(4 * Math.max(0, mult - 1));

/** Desfecho pelo total contra a CD: +10 crítico, passou sucesso, até 3 abaixo parcial, senão falha. */
export function outcomeOf(total: number, dc: number, crit?: "success" | "failure"): Outcome {
  if (crit === "failure") return "fail";
  if (crit === "success" || total >= dc + 10) return "crit";
  if (total >= dc) return "success";
  return total >= dc - 3 ? "partial" : "fail";
}

export function resourceLevel(current: number, max: number): ResourceLevel {
  if (current <= 0) return "empty";
  const p = max > 0 ? current / max : 0;
  return p >= 0.85 ? "full" : p >= 0.4 ? "steady" : "low";
}
export const RESOURCE_WORDS: Record<ResourceLevel, string> = { full: "cheio", steady: "firme", low: "baixo", empty: "esgotado" };
export const masteryWord = (p: number) => (p >= 90 ? "mestre" : p >= 60 ? "sólido" : p >= 25 ? "praticando" : "iniciante");

const OUTCOME_WORDS: Record<Outcome, string> = {
  crit: "deu muito certo, melhor do que o esperado",
  success: "deu certo",
  partial: "deu certo só pela metade: funciona, mas incompleto ou com um preço",
  fail: "falhou",
};
export const PERCEIVED: Record<Outcome, string> = { crit: "limpo e marcante", success: "funciona", partial: "hesitante, incompleto", fail: "não funciona" };
const COST_WORDS = { none: "", light: "custou pouco", heavy: "custou caro" };

/** Resultado de um passo em palavras, sem número. */
export function resultLine(r: StepResult): string {
  const res = r.resource && r.resourceLabel ? `${r.resourceLabel}: ${RESOURCE_WORDS[r.resource]}` : "";
  return `- ${r.intent}: ${OUTCOME_WORDS[r.result]}${[COST_WORDS[r.cost], res].filter(Boolean).map((s) => `; ${s}`).join("")}.${r.note ? ` ${r.note}` : ""}`;
}

// ---------- oráculo (Mythic, tabela fixa, caos 5) ----------

export const ORACLE_ODDS: Record<Likelihood, number> = {
  impossible: 5,
  very_unlikely: 15,
  unlikely: 30,
  even: 50,
  likely: 70,
  very_likely: 85,
  certain: 95,
};
export type OracleAnswer = "exceptional_yes" | "yes" | "no" | "exceptional_no";

/** d100 contra a chance da categoria: o 1º quinto do sim é sim excepcional, o último quinto do não é não excepcional. */
export function oracle(likelihood: Likelihood, d100: number): OracleAnswer {
  const p = ORACLE_ODDS[likelihood];
  if (d100 <= p) return d100 <= Math.ceil(p / 5) ? "exceptional_yes" : "yes";
  return d100 > 100 - Math.floor((100 - p) / 5) ? "exceptional_no" : "no";
}
export const ORACLE_WORDS: Record<OracleAnswer, string> = {
  exceptional_yes: "sim, e mais do que isso",
  yes: "sim",
  no: "não",
  exceptional_no: "não, e pior do que isso",
};

/**
 * Custo das habilidades sem banco e sem IA:
 *  - genérico: ruleset sem custo, só com byRank, e um mundo de magia com faixas próprias (fraco/moderado/forte, mana)
 *    e sem costControlLabel; normalização das faixas; arredondamento; unidades; multiplicadores; validação do Criador
 *    de aventuras; substituições de prompt idempotentes;
 *  - praticabilidade no mundo naruto (naruto-ruleset.json + scripts/data/naruto-costs.json): quantos usos cada pool
 *    permite, com asserções de faixa pelo cânone, e a tabela impressa.
 * Rodar: npx tsx scripts/cost-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_AGENTS, LIBRARY_PROMPT_FIXES } from "../src/lib/agents";
import { draftIssues, type Draft } from "../src/lib/adventure";
import { normalizeAbility } from "../src/lib/library";
import { controlLabel, costBreakdown, effectiveCost } from "../src/lib/progression";
import { abilityCost, abilityPromptLine, DEFAULT_RULESET, normalizeRuleset, rulesetPromptSummary } from "../src/lib/ruleset";
import type { Ability, Ruleset } from "../src/lib/types";

const ok = (m: string) => console.log(`✔ ${m}`);
const ab = (o: Partial<Ability>): Ability => ({ name: "T", type: "x", progress: 50, ...o });

// ---------- genérico ----------
{
  const bare = normalizeRuleset({ ...DEFAULT_RULESET, abilityCosts: undefined });
  assert.equal(effectiveCost(bare, ab({ rank: "D" })), null, "mundo sem abilityCosts: sem custo");
  assert.equal(abilityCost(bare, ab({ consumption: "baixo" })), null);
  const byRank = normalizeRuleset({ ...DEFAULT_RULESET, abilityRanks: ["I", "II"], abilityCosts: { resource: "energia", byRank: { I: 4, II: 10 } } });
  assert.equal(byRank.abilityCosts!.byConsumption, undefined);
  assert.equal(effectiveCost(byRank, ab({ rank: "II" }))!.amount, 10, "só byRank: como antes");
  assert.equal(effectiveCost(byRank, ab({ rank: "II", consumption: "forte" }))!.amount, 10, "faixa sem byConsumption no mundo: vale o rank");
  assert.equal(effectiveCost(byRank, ab({ rank: "I", costUnit: "rodada" }), { units: 3 })!.amount, 12, "unidade vale mesmo sem faixas");
  assert.equal(effectiveCost(byRank, ab({}))?.amount, undefined, "sem rank e sem faixa: sem custo calculável");
  assert.doesNotMatch(rulesetPromptSummary(byRank), /Faixas de consumo/);
  assert.equal(normalizeAbility(byRank, { name: "A", type: DEFAULT_RULESET.abilityTypes[0]?.key ?? "x", consumption: "forte" })?.consumption, undefined, "sem faixas no mundo, consumption cai fora");
  ok("ruleset sem custo e só com byRank: comportamento de antes; faixa e unidade opcionais");
}

const magic = normalizeRuleset({
  ...DEFAULT_RULESET,
  name: "Escola de Magia",
  resources: [{ key: "hp", label: "Vida", defaultMax: 20 }, { key: "mana", label: "Mana", defaultMax: 40 }],
  abilityTypes: [{ key: "feitico", label: "Feitiço" }],
  abilityRanks: ["1", "2", "3"],
  abilityCosts: {
    resource: "mana",
    byRank: { "1": 2, "2": 5, "3": 9 },
    byConsumption: [
      { key: "fraco", label: "Fraco", cost: 2 },
      { key: "moderado", label: "Moderado", cost: 5 },
      { key: "forte", label: "Forte", cost: 10 },
      { key: "ruim", label: "", cost: 3 }, // inválida: sem nome
      { key: "neg", label: "Neg", cost: -1 }, // inválida: custo negativo
    ],
  },
} as unknown as Ruleset);
{
  assert.deepEqual(magic.abilityCosts!.byConsumption!.map((b) => b.key), ["fraco", "moderado", "forte"], "faixas inválidas caem fora");
  assert.equal(magic.costControlLabel, undefined);
  assert.equal(controlLabel(magic), "Eficiência", "sem costControlLabel: rótulo genérico");
  const patrono = normalizeAbility(magic, { name: "Patrono", type: "Feitiço", rank: "3", consumption: "Moderado", costUnit: " Rodada " })!;
  assert.deepEqual([patrono.consumption, patrono.costUnit], ["moderado", "rodada"], "faixa pela key ou pelo nome do mundo; unidade limpa");
  const p = { ...patrono, progress: 50 };
  // faixa (5) vence o rank (9); × 3 rodadas
  let c = effectiveCost(magic, p, { units: 3 })!;
  assert.deepEqual([c.base, c.perUnit, c.amount, c.resource], [5, 5, 15, "mana"]);
  assert.equal(costBreakdown(magic, p, c), "base 5 (moderado) por rodada × 3 = 15");
  // eficiência ruim 1,25 × domínio < 25% 1,5 = 1,875: uma rodada 9,375 → 10; duas 18,75 → 19 (acréscimo para cima, no total)
  c = effectiveCost(magic, { ...p, progress: 10 }, { sheet: { costMult: 1.25 }, units: 2 })!;
  assert.deepEqual([c.perUnit, c.amount], [10, 19]);
  assert.equal(costBreakdown(magic, { ...p, progress: 10 }, c), "base 5 (moderado) por rodada × 2 × eficiência ×1,25 × domínio ×1,5 = 19");
  // desconto no total: 10 rodadas fracas com 0,75 × 0,75 = 11,25 → 11 (por rodada sozinha seria 1)
  c = effectiveCost(magic, ab({ consumption: "fraco", costUnit: "rodada", progress: 100 }), { sheet: { costMult: 0.75 }, units: 10 })!;
  assert.deepEqual([c.perUnit, c.amount], [1, 11]);
  // desconto para baixo, nunca abaixo de 1
  assert.equal(effectiveCost(magic, ab({ consumption: "fraco", progress: 100, costMult: 0.5 }), { sheet: { costMult: 0.5 } })!.amount, 1, "2 × 0,5 × 0,5 × 0,75 = 0,375 → mínimo 1");
  assert.equal(effectiveCost(magic, ab({ consumption: "fraco", costFree: true }))!.amount, 0, "costFree vence a faixa");
  // limites: unidades e multiplicadores fora da faixa são contidos
  assert.equal(effectiveCost(magic, ab({ consumption: "fraco", costUnit: "rodada" }), { units: 0 })!.units, 1);
  assert.equal(effectiveCost(magic, ab({ consumption: "fraco", costUnit: "rodada" }), { units: 1e9 })!.units, 1000);
  assert.equal(effectiveCost(magic, ab({ consumption: "fraco" }), { units: 50 })!.amount, 2, "sem costUnit, units é ignorado");
  assert.equal(effectiveCost(magic, ab({ consumption: "forte", costMult: 9 }))!.linkMult, 2, "costMult gravado acima do teto: 2");
  const sum = rulesetPromptSummary(magic);
  assert.match(sum, /Faixas de consumo \(mana[^)]*\): Fraco=2, Moderado=5, Forte=10/);
  assert.match(sum, /Eficiência: multiplicador de custo/);
  const line = abilityPromptLine(magic, p, Infinity, { costMult: 0.75 });
  assert.match(line, /consumo moderado/);
  assert.match(line, /custo 3 mana por rodada \(use_ability com units\) \(base 5 \(moderado\) por rodada × eficiência ×0,75 = 3\)/, line);
  for (const t of [sum, line, costBreakdown(magic, p, effectiveCost(magic, p)!)]) assert.doesNotMatch(t, /chakra|jutsu|clone/i, "nada de Naruto num mundo de magia");
  ok("mundo de magia: faixas fraco/moderado/forte em mana, rótulo genérico, arredondamento, unidades, limites e textos sem Naruto");
}

// Criador de aventuras: faixas e rótulo opcionais, validados
{
  const naruto = JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")) as Draft;
  assert.deepEqual(draftIssues(naruto), [], "Naruto (com faixas e rótulo) passa");
  const noBands = { ...naruto, abilityCosts: { resource: "chakra", byRank: naruto.abilityCosts!.byRank }, costControlLabel: undefined };
  assert.deepEqual(draftIssues(noBands), [], "sem faixas nem rótulo também passa");
  const bad = { ...naruto, costControlLabel: " ", abilityCosts: { ...naruto.abilityCosts!, byConsumption: [{ key: "a", label: "A", cost: "x" }] } } as unknown as Draft;
  const issues = draftIssues(bad);
  assert.ok(issues.some((i) => /byConsumption: lista/.test(i)) && issues.some((i) => /costControlLabel/.test(i)), issues.join("\n"));
  const firstRank = naruto.ranks![0].key;
  const kit = { ...naruto, startingAbilities: { ...naruto.startingAbilities, [firstRank]: [{ ...naruto.startingAbilities![firstRank][0], consumption: "nenhuma" }] } } as Draft;
  assert.ok(draftIssues(kit).some((i) => /consumption "nenhuma"/.test(i)));
  ok("Criador de aventuras: byConsumption e costControlLabel opcionais e validados");
}

// prompts gravados: as substituições valem uma vez só e o padrão já vem com o texto novo
{
  for (const [id, from, to] of LIBRARY_PROMPT_FIXES) {
    assert.ok(!to.includes(from), `${id}: o novo contém o antigo (rodaria de novo)`);
    const def = DEFAULT_AGENTS.find((a) => a.id === id)!.system_prompt;
    const old = def.replace(to, from);
    const fixed = old.replaceAll(from, to);
    if (def.includes(to)) assert.equal(fixed, def, `${id}: aplicar no prompt antigo dá o padrão`);
    assert.equal(fixed.replaceAll(from, to), fixed, `${id}: rodar de novo não muda`);
  }
  const mine = LIBRARY_PROMPT_FIXES.filter(([, , to]) => /set_cost_modifier|consumption|costMult|byConsumption/.test(to));
  assert.ok(mine.length >= 6, "fixes do custo presentes");
  for (const [id, , to] of mine) assert.ok(DEFAULT_AGENTS.find((a) => a.id === id)!.system_prompt.includes(to), `${id}: padrão com o texto novo`);
  ok(`prompts: ${mine.length} substituições do custo idempotentes e iguais ao padrão`);
}

// ---------- praticabilidade no mundo naruto ----------
const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
const MAP = JSON.parse(fs.readFileSync("scripts/data/naruto-costs.json", "utf-8")) as {
  abilities: Record<string, { consumption?: string; costUnit?: string }>;
  characters: Record<string, { costMult?: number; abilities?: Record<string, number> }>;
};
// rank das técnicas da biblioteca naruto (só para mostrar; o custo vem da faixa)
const RANK: Record<string, string> = {
  "Henge no Jutsu": "D", "Kawarimi no Jutsu": "D", "Bunshin no Jutsu": "D", "Genjutsu Kai": "D", "Shunshin no Jutsu": "D",
  "Katon: Gōkakyū no Jutsu": "C", "Katon: Hōsenka no Jutsu": "C", "Fūton: Daitoppa": "C", "Kuchiyose no Jutsu": "C",
  "Kage Bunshin no Jutsu": "B", "Sharingan": "B", "Doton: Doryūheki": "B", "Suiton: Suiryūdan no Jutsu": "B", "Katon: Karyū Endan": "B",
  "Rasengan": "A", "Chidori": "A",
};
const tech = (name: string, progress = 50, costMult?: number): Ability => {
  const m = MAP.abilities[name];
  assert.ok(m?.consumption, `${name} no mapa com faixa`);
  return { name, type: "ninjutsu", rank: RANK[name], consumption: m.consumption, costUnit: m.costUnit, progress, costMult };
};
const short = (n: string) => n.replace(/ no Jutsu$/, "").replace(/^(Katon|Fūton|Doton|Suiton): /, "");
const ACADEMY = ["Henge no Jutsu", "Kawarimi no Jutsu", "Bunshin no Jutsu", "Genjutsu Kai", "Shunshin no Jutsu"];
const COMMON = [...ACADEMY, "Katon: Gōkakyū no Jutsu", "Fūton: Daitoppa", "Kage Bunshin no Jutsu", "Kuchiyose no Jutsu", "Doton: Doryūheki", "Suiton: Suiryūdan no Jutsu", "Rasengan", "Chidori", "Sharingan"];
const TYPES: [string, number][] = [["Genin 45", 45], ["Genin 50", 50], ["Genin 65", 65], ["Chunin 50", 50], ["Jounin 160", 160], ["Kage 190", 190]];
/** usos (ou unidades, com costUnit, num uso só) que o pool cheio paga, pela função de custo real (arredondada no total) */
const fits = (pool: number, a: Ability, costMult?: number) => {
  let n = 0;
  while (n < 1000 && effectiveCost(rs, a, { sheet: { costMult }, units: a.costUnit ? n + 1 : 1 })!.amount * (a.costUnit ? 1 : n + 1) <= pool) n++;
  return n;
};
const uses = (pool: number, a: Ability, costMult?: number) => {
  const c = effectiveCost(rs, a, { sheet: { costMult } })!;
  return { cost: c.perUnit, n: fits(pool, a, costMult), unit: c.unit };
};

console.log(`\nPraticabilidade (domínio 50% = custo ×1, controle 1): custo por uso (ou por unidade) → usos com o pool cheio`);
console.log(["técnica | faixa", ...TYPES.map(([t]) => t)].join(" | "));
for (const name of COMMON) {
  const a = tech(name);
  const row = TYPES.map(([, pool]) => {
    const u = uses(pool, a);
    return `${u.cost}${u.unit ? `/${u.unit}` : ""} → ${u.n}`;
  });
  console.log([`${short(name)} (${a.rank}) | ${a.consumption}${a.costUnit ? `/${a.costUnit}` : ""}`, ...row].join(" | "));
}

// asserções pelo cânone (pool cheio, domínio típico 50%)
for (const name of ACADEMY) {
  for (const pool of [45, 50]) {
    assert.ok(uses(pool, tech(name)).n >= 20, `${name}: Genin ${pool} usa dezenas de vezes`);
    assert.ok(uses(pool, tech(name, 15)).cost <= pool * 0.05, `${name}: nunca mais de ~5% do pool de um Genin, nem com domínio baixo`);
  }
}
for (const pool of [50, 65]) {
  const n = uses(pool, tech("Katon: Gōkakyū no Jutsu")).n;
  assert.ok(n >= 6 && n <= 10, `Katon C: Genin ${pool} usa ~6–10 vezes (${n})`);
}
const chidori = uses(160, tech("Chidori")).n;
assert.ok(chidori >= 4 && chidori <= 8, `Chidori: Jounin 160 ~4–8 vezes (${chidori})`);
assert.ok(uses(65, tech("Chidori")).n <= 3, "Chidori: Genin 65 (Sasuke) no máximo 2–3 por dia");
for (const pool of [45, 50]) {
  const n = uses(pool, tech("Kage Bunshin no Jutsu")).n;
  assert.ok(n >= 5 && n <= 16, `Kage Bunshin: Genin comum ${pool} ~5–15 clones no total (${n})`);
}
ok("praticabilidade: Academia barata (≤5% do pool), Katon C 6–10 por Genin, Chidori 4–8 por Jounin, Kage Bunshin 5–16 clones por Genin");

// campanha atual: pools, domínio e costMult propostos (scripts/data/naruto-costs.json)
const CAST: [string, number, [string, number][]][] = [
  ["Hugo", 50, [["Henge no Jutsu", 62], ["Kage Bunshin no Jutsu", 43], ["Katon: Gōkakyū no Jutsu", 21], ["Fūton: Daitoppa", 15]]],
  ["Sakura Haruno", 45, [["Henge no Jutsu", 80], ["Kawarimi no Jutsu", 65], ["Bunshin no Jutsu", 80]]],
  ["Sasuke Uchiha", 65, [["Katon: Gōkakyū no Jutsu", 75], ["Katon: Hōsenka no Jutsu", 60]]],
  ["Naruto Uzumaki", 50, [["Kage Bunshin no Jutsu", 50], ["Henge no Jutsu", 30], ["Bunshin no Jutsu", 15]]],
  ["Iruka Umino", 50, [["Henge no Jutsu", 50], ["Bunshin no Jutsu", 50]]],
  ["Kakashi Hatake", 160, [["Chidori", 100], ["Sharingan", 95], ["Kage Bunshin no Jutsu", 95], ["Kuchiyose no Jutsu", 100], ["Suiton: Suiryūdan no Jutsu", 90], ["Doton: Doryūheki", 95]]],
  ["Hiruzen Sarutobi", 190, [["Kage Bunshin no Jutsu", 100], ["Katon: Karyū Endan", 100], ["Doton: Doryūheki", 100], ["Kuchiyose no Jutsu", 100]]],
];
console.log(`\nCampanha atual (domínio da ficha, controle proposto): técnica custo → usos`);
for (const [who, pool, list] of CAST) {
  const spec = MAP.characters[who] ?? {};
  const cells = list.map(([name, p]) => {
    const a = tech(name, p, spec.abilities?.[name]);
    const c = effectiveCost(rs, a, { sheet: { costMult: spec.costMult } })!;
    return `${short(name)} ${c.perUnit}${c.unit ? `/${c.unit}` : ""} → ${fits(pool, a, spec.costMult)}`;
  });
  console.log(`${who} (${pool}, controle ×${spec.costMult ?? 1}): ${cells.join("; ")}`);
}
const kk = MAP.characters["Kakashi Hatake"];
const sharingan = effectiveCost(rs, tech("Sharingan", 95, kk.abilities?.Sharingan), { sheet: kk, units: 10 })!;
const chid = effectiveCost(rs, tech("Chidori", 100), { sheet: kk })!;
console.log(`Kakashi numa luta: Sharingan 10 rodadas = ${sharingan.amount} + Chidori ${chid.perUnit} cada → ${Math.floor((160 - sharingan.amount) / chid.perUnit)} Chidori`);
assert.ok(fits(160, tech("Chidori", 100), kk.costMult) >= 4 && fits(160, tech("Chidori", 100), kk.costMult) <= 8, "Kakashi da campanha (domínio 100%, controle bom): Chidori ~4–8");
assert.ok(Math.floor((160 - sharingan.amount) / chid.perUnit) >= 3, "Kakashi com Sharingan ativo ainda tem alguns Chidori");
console.log("\ncost-check: ok");

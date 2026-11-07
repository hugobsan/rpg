/**
 * Contrato do Narrador sem IA (src/lib/contracts.ts), com trechos reais da campanha em scripts/eval/fixtures:
 *  - prose.json: o validador de prosa reprova número de regra (#3873 "uma rodada custa um ponto", #3615 "nove pontos
 *    mais seis") e deixa passar narração boa, hora, preço, distância e quantidade de clones;
 *  - effects.json: parse tolerante do bloco ```efeitos e validação campo a campo (técnica fora da ficha descarta o passo,
 *    bloco quebrado vai ao Anotador, campo ruim sai sozinho);
 *  - interpreter.json: saída do Intérprete contra a ficha;
 *  - tabelas fixas: oráculo Mythic, desfecho pela CD, níveis de recurso e domínio; o tamanho do prompt do Narrador;
 *  - opções de missão (3-4, composta da ficha, avanço), "told" pela fala entre aspas e pagamento padrão da missão.
 * Rodar: npx tsx scripts/eval-check.ts
 *
 * Métrica (lê o banco, sem IA): npx tsx scripts/eval-check.ts --campaign <id> — nas narrações gravadas (messages gm),
 * a taxa das que terminam em pergunta, das que trazem número de regra (validador de prosa) e das que tiveram fala de
 * NPC fora do SABE (meta.leaks, gravado desde a F3).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  dcFor,
  missionOptions,
  spokenTold,
  type EffectsCtx,
  masteryWord,
  optionSteps,
  oracle,
  outcomeOf,
  parseLooseJson,
  proseIssues,
  resourceLevel,
  splitNarration,
  validateEffects,
  validateInterpretation,
} from "../src/lib/contracts";
import { DEFAULT_AGENTS } from "../src/lib/agents";
import { validateCard } from "../src/lib/story";
import { defaultPay } from "../src/lib/objectives";

/** Último parágrafo de prosa (sem o bloco e sem lista de opções no fim). */
function lastParagraph(text: string): string {
  const lines = splitNarration(text).prose.split("\n").map((l) => l.trim()).filter(Boolean);
  while (lines.length && /^(\d+[.)]|[-*•])\s/.test(lines.at(-1)!)) lines.pop();
  return lines.at(-1) ?? "";
}
/** Termina em pergunta: o último parágrafo acaba em "?" (estrito). */
export const endsInQuestion = (text: string) => /\?[\s*_"”'’»)]*$/.test(lastParagraph(text));

async function metrics(id: string) {
  const { q, pool } = await import("../src/lib/db");
  try {
    const [c] = await q<{ name: string; ruleset: { resources?: { key: string; label: string }[] } }>(`SELECT name, ruleset FROM campaigns WHERE id = $1`, [id]);
    if (!c) throw new Error(`campanha ${id} não existe`);
    const rows = await q<{ content: string; meta: { leaks?: string[] } | null }>(`SELECT content, meta FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id`, [id]);
    const words = (c.ruleset.resources ?? []).flatMap((r) => [r.key, r.label]);
    const pct = (k: number) => `${k}/${rows.length} (${rows.length ? Math.round((k / rows.length) * 100) : 0}%)`;
    const q1 = rows.filter((r) => endsInQuestion(r.content)).length;
    const nums = rows.filter((r) => proseIssues(splitNarration(r.content).prose, words).length).length;
    const leaks = rows.filter((r) => r.meta?.leaks?.length).length;
    console.log(`${c.name} (${id}): ${rows.length} narrações`);
    const q2 = rows.filter((r) => lastParagraph(r.content).includes("?")).length;
    console.log(`  terminam em pergunta: ${pct(q1)}`);
    console.log(`  pergunta no último parágrafo: ${pct(q2)} (mais solto)`);
    console.log(`  com número de regra:  ${pct(nums)}`);
    console.log(`  fala fora do SABE:    ${pct(leaks)} (meta.leaks, só desde a F3)`);
  } finally {
    await pool().end();
  }
}

const at = process.argv.indexOf("--campaign");
if (at >= 0) {
  metrics(process.argv[at + 1] ?? "").catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else checks();

function checks() {

const dir = path.join(__dirname, "eval", "fixtures");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
let n = 0;
const ok = (msg: string) => (n++, console.log(`ok: ${msg}`));

// ---------- prosa ----------
const prose = load("prose.json") as { resourceWords: string[]; cases: { id: string; text: string; expect: "pass" | "fail" }[] };
for (const c of prose.cases) {
  const issues = proseIssues(c.text, prose.resourceWords);
  if (c.expect === "fail") assert.ok(issues.length, `#${c.id} devia reprovar`);
  else assert.deepEqual(issues, [], `#${c.id} devia passar`);
  ok(`prosa #${c.id} ${c.expect === "fail" ? `reprova (${issues.slice(0, 3).join(" | ")})` : "passa"}`);
}
assert.ok(proseIssues("Uma rodada de Kanchi custa um ponto.", prose.resourceWords).some((i) => /rodada|ponto/.test(i)));
assert.deepEqual(proseIssues("Uma vida inteira de treino; às duas da manhã, a trinta metros, três clones e dez horas de estrada.", prose.resourceWords), []);

// ---------- bloco de efeitos ----------
const fxFile = load("effects.json") as { ctx: EffectsCtx; cases: { id: string; text: string; expect: Record<string, unknown> }[] };
for (const c of fxFile.cases) {
  const { prose: p, block } = splitNarration(c.text);
  const e = c.expect;
  if (e.prose !== undefined) assert.equal(p, e.prose, `${c.id}: prosa sem o bloco`);
  assert.ok(!/```|"options"/.test(p), `${c.id}: o bloco não vaza na prosa`);
  const raw = block ? parseLooseJson(block) : null;
  if (e.unreadable) {
    assert.equal(raw, null, `${c.id}: bloco quebrado é ilegível (Anotador; sem IA, efeitos vazios)`);
    ok(`efeitos ${c.id}: ilegível → Anotador`);
    continue;
  }
  assert.ok(raw, `${c.id}: bloco legível`);
  const { effects: fx, dropped } = validateEffects(raw, fxFile.ctx);
  if (e.options !== undefined) assert.equal(fx.options.length, e.options, `${c.id}: opções`);
  if (e.firstStepAbility !== undefined) assert.equal(fx.options[0].steps[0]?.ability, e.firstStepAbility, `${c.id}: técnica do passo`);
  if (e.firstOptionSteps !== undefined) assert.equal(fx.options[0].steps.length, e.firstOptionSteps, `${c.id}: passos que sobraram`);
  if (e.firstLabel !== undefined) assert.equal(fx.options[0].label, e.firstLabel);
  if (e.time !== undefined) assert.equal(fx.time, e.time, `${c.id}: time`);
  if (e.rest !== undefined) assert.equal(fx.rest, e.rest);
  if (e.present !== undefined) assert.deepEqual(fx.scene.present, e.present, `${c.id}: present`);
  if (e.facts !== undefined) assert.equal(fx.facts.length, e.facts, `${c.id}: fatos`);
  if (e.told !== undefined) assert.equal(fx.told.length, e.told);
  if (e.items !== undefined) assert.deepEqual(fx.items, e.items, `${c.id}: itens`);
  if (e.newNpcs !== undefined) assert.equal(fx.newNpcs.length, e.newNpcs);
  if ("purchase" in e) assert.deepEqual(fx.purchase, e.purchase);
  if ("mission" in e) assert.deepEqual(fx.mission, e.mission);
  if (e.missionId !== undefined) assert.equal(fx.mission?.id, e.missionId);
  if (e.dropped !== undefined) assert.equal(dropped.length, e.dropped, `${c.id}: descartes ${JSON.stringify(dropped)}`);
  if (e.droppedHas !== undefined) assert.ok(dropped.some((d) => d.startsWith(String(e.droppedHas))), `${c.id}: ${JSON.stringify(dropped)}`);
  ok(`efeitos ${c.id}${dropped.length ? ` (descartou: ${dropped.join("; ")})` : ""}`);
}

// opção escolhida → passos tipados, sem Intérprete
const steps = optionSteps({ label: "Clone segura e kunai", approach: "force", steps: [{ ability: "Kage Bunshin no Jutsu", target: "Javali" }, { item: "Kunai" }] });
assert.deepEqual(steps.map((s) => [s.kind, s.ability ?? s.item, s.difficulty]), [["ability", "Kage Bunshin no Jutsu", "hard"], ["item", "Kunai", "hard"]]);
assert.deepEqual(optionSteps({ label: "Espero", approach: "wait", steps: [] }).map((s) => [s.kind, s.difficulty]), [["wait", "trivial"]]);
ok("opção tipada vira passos sem Intérprete");

// ---------- Intérprete ----------
const it = load("interpreter.json") as { ctx: Parameters<typeof validateInterpretation>[1]; cases: { id: string; raw: string; expect: Record<string, unknown> }[] };
for (const c of it.cases) {
  const r = validateInterpretation(parseLooseJson(c.raw), it.ctx);
  if (c.expect.null) {
    assert.equal(r, null, c.id);
    ok(`intérprete ${c.id}: inválido → nova tentativa / passo genérico`);
    continue;
  }
  assert.ok(r, c.id);
  assert.equal(r.steps.length, c.expect.steps);
  assert.deepEqual(r.steps.map((s) => s.kind), c.expect.kinds);
  if (c.expect.abilities) assert.deepEqual(r.steps.map((s) => s.ability ?? null), c.expect.abilities);
  if (c.expect.items) assert.deepEqual(r.steps.map((s) => s.item ?? null), c.expect.items);
  if (c.expect.declaresOutcome !== undefined) assert.equal(r.declaresOutcome, c.expect.declaresOutcome);
  if (c.expect.likelihood) assert.equal(r.question?.likelihood, c.expect.likelihood);
  ok(`intérprete ${c.id}`);
}

// ---------- missão: opções, "told" pela fala, pagamento padrão ----------
const sheetCtx = { abilities: ["Kage Bunshin no Jutsu", "Henge no Jutsu"], items: ["Kunai", "Papel-bomba"], exits: ["Seguir o rastro até o rio", "Voltar e avisar Genma"] };
const plain = missionOptions([{ label: "Pergunto ao velho o que viu", approach: "talk", steps: [] }], { ...sheetCtx, seed: 0 });
assert.ok(plain.length >= 3 && plain.length <= 4, JSON.stringify(plain));
assert.ok(plain.some((o) => o.steps.filter((x) => x.ability || x.item).length >= 2), "composta montada da ficha");
assert.ok(plain.some((o) => o.approach === "move"), "uma de avanço");
assert.equal(plain[0].label, "Pergunto ao velho o que viu", "as do Narrador vêm primeiro");
const full = missionOptions(
  [
    { label: "A", approach: "talk", steps: [] }, { label: "B", approach: "force", steps: [] }, { label: "C", approach: "sense", steps: [] },
    { label: "Saio pela janela", approach: "exit", steps: [] },
  ],
  sheetCtx
);
assert.equal(full.length, 4, "nunca mais de 4");
assert.ok(full.some((o) => o.steps.length >= 2) && full.some((o) => o.approach === "move"), "a composta e o avanço entram no lugar das últimas");
const kept = missionOptions([{ label: "Clone e kunai cercam o javali", approach: "force", steps: [{ ability: "Kage Bunshin no Jutsu" }, { item: "Kunai" }] }, { label: "Saio pela janela", approach: "exit", steps: [] }, { label: "Corro até a ponte", approach: "move", steps: [] }], sheetCtx);
assert.deepEqual(kept.map((o) => o.label), ["Clone e kunai cercam o javali", "Abandonar a missão: Saio pela janela", "Corro até a ponte"], "exit diz que abandona");
assert.ok(missionOptions([], { abilities: [], items: [], exits: [] }).length >= 3, "sem ficha nem cartão: ainda 3 opções");
assert.deepEqual(spokenTold('Olho para Genma. "Vi um homem pálido rondando o portão ontem à noite."', "Hugo", "Genma"), { fact: "Vi um homem pálido rondando o portão ontem à noite.", by: "Hugo", to: ["Genma"] });
assert.equal(spokenTold('"Você viu o homem pálido?"', "Hugo", "Genma"), null, "pergunta não é contar");
assert.equal(spokenTold("conto ao Genma o que vi", "Hugo", "Genma"), null, "sem aspas: o bloco do Narrador cobre");
assert.equal(spokenTold("— Achei a kunai do ladrão perto da ponte velha.", "Hugo", "Genma")?.fact, "Achei a kunai do ladrão perto da ponte velha.");
const ryo = { units: [{ key: "ryo", label: "Ryō", value: 1 }], prices: "Missões: rank D 5 mil a 50 mil ryō; C 30 mil a 100 mil; B 80 mil a 200 mil" };
assert.deepEqual([defaultPay(ryo, "pequena"), defaultPay(ryo, "media"), defaultPay(ryo, "grande"), defaultPay(undefined)], [5000, 30000, 80000, undefined]);
assert.equal(defaultPay({ units: [{ key: "po", label: "PO", value: 1 }], start: 500 }, "media"), 100, "sem faixa: décimo do saldo inicial x2");
ok("missão: opções garantidas, told pela fala entre aspas, pagamento padrão");

// ---------- tabelas fixas ----------
assert.deepEqual([dcFor("easy", 2), dcFor("medium", 2), dcFor("hard", 2), dcFor("very_hard", 2)], [14, 18, 22, 26], "Naruto ×2 = diceNotes");
assert.equal(dcFor("medium", 1), 14);
assert.deepEqual([outcomeOf(28, 18), outcomeOf(18, 18), outcomeOf(15, 18), outcomeOf(14, 18), outcomeOf(30, 18, "failure"), outcomeOf(5, 18, "success")], ["crit", "success", "partial", "fail", "fail", "crit"]);
assert.deepEqual([oracle("even", 10), oracle("even", 50), oracle("even", 51), oracle("even", 91), oracle("certain", 95), oracle("impossible", 6)], ["exceptional_yes", "yes", "no", "exceptional_no", "yes", "no"]);
assert.deepEqual([resourceLevel(50, 50), resourceLevel(25, 50), resourceLevel(5, 50), resourceLevel(0, 50)], ["full", "steady", "low", "empty"]);
assert.deepEqual([masteryWord(10), masteryWord(40), masteryWord(70), masteryWord(95)], ["iniciante", "praticando", "sólido", "mestre"]);
ok("tabelas: CD, desfecho, oráculo, níveis");

// ---------- prompts curtos (R2: system ≤ ~1,5k tokens) ----------
for (const id of ["gm", "interpreter", "scribe", "director", "scriptwriter", "npc"]) {
  const a = DEFAULT_AGENTS.find((x) => x.id === id)!;
  assert.ok(a.system_prompt.length / 3.5 <= 1500, `${id}: ${a.system_prompt.length} caracteres`);
  // o exemplo do prompt passa no próprio validador
  if (id === "gm") {
    const ex = splitNarration(a.system_prompt.slice(a.system_prompt.indexOf("EXEMPLO")));
    assert.deepEqual(proseIssues(ex.prose, ["chakra", "Chakra"]), []);
    assert.equal(validateEffects(parseLooseJson(ex.block!), { ...fxFile.ctx, npcs: ["Genma"] }).dropped.length, 0, "exemplo do Narrador válido");
  }
}
assert.ok(!DEFAULT_AGENTS.some((a) => ["referee", "suggest", "chronicler"].includes(a.id)), "Árbitro, Ações rápidas e Cronista saíram");
// o exemplo do Diretor passa no validador do cartão
const dirPrompt = DEFAULT_AGENTS.find((a) => a.id === "director")!.system_prompt;
const card = validateCard(parseLooseJson(dirPrompt.slice(dirPrompt.indexOf("Exemplo:"))), { beats: [{ id: "3f9a1c2e-0000-4000-8000-000000000000" } as never], names: ["Tazuna"] });
assert.deepEqual(card.errors, [], "exemplo do Diretor válido");
assert.equal(card.card?.npcIntents.length, 1);
ok("prompts curtos e exemplo válido");

console.log(`\n${n} verificações ok`);
assert.ok(endsInQuestion('**Genma:** "E você, vai ficar aí parado?"\n```efeitos\n{}\n```') && !endsInQuestion("Ele se vira e sai."), "métrica de pergunta");
}

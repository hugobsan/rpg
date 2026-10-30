/**
 * Checagem da progressão (domínio, nível de poder, pontos livres, teto, treino) sem IA.
 * Parte pura sobre o naruto-ruleset.json e parte de banco: cria uma campanha de teste,
 * chama as ferramentas do Mestre direto (use_ability, train, update_attribute, grant_xp)
 * e apaga a campanha no fim.
 *
 *   npx tsx scripts/progression-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { q, pool } from "../src/lib/db";
import { blankSheet, normalizeRuleset, startingKit } from "../src/lib/ruleset";
import {
  attributeCap, attributePoints, effectiveCost, LEGACY_MASTERY, masteryBonus, powerLevel, raiseBlocked, train,
} from "../src/lib/progression";
import { executeGmTool, ToolContext } from "../src/lib/tools";
import type { Ability, Campaign, Character, Scene, Sheet, TurnEvent } from "../src/lib/types";

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
let n = 0;
const ok = (label: string, fn: () => void) => {
  fn();
  n++;
  console.log(`✔ ${label}`);
};
const ab = (progress: number | undefined, rank = "D"): Ability => ({ name: "X", type: "ninjutsu", rank, progress });

// ---------- domínio: bônus e custo por faixa ----------
ok("bônus por faixa de domínio", () => {
  for (const [p, b] of [[0, 0], [24, 0], [25, 1], [49, 1], [50, 2], [74, 2], [75, 3], [99, 3], [100, 4]])
    assert.equal(masteryBonus(rs, ab(p)), b, `domínio ${p}`);
  assert.equal(masteryBonus(rs, ab(undefined)), 2, "sem progress = LEGACY_MASTERY (50)");
  assert.equal(LEGACY_MASTERY, 50);
});
ok("custo por faixa de domínio (D=3, C=6, S=35)", () => {
  const c = (p: number, rank: string) => effectiveCost(rs, ab(p, rank))!.amount;
  assert.equal(c(10, "D"), 5); // 4,5 → 5 (para cima)
  assert.equal(c(24, "C"), 9);
  assert.equal(c(25, "D"), 3);
  assert.equal(c(99, "C"), 6);
  assert.equal(c(100, "D"), 2); // 2,25 → 2 (desconto para baixo)
  assert.equal(c(100, "C"), 4); // 4,5 → 4
  assert.equal(c(100, "S"), 26);
  assert.equal(c(0, "S"), 53); // 52,5 → 53
  assert.equal(effectiveCost(rs, { ...ab(10), cost: { resource: "chakra", amount: 0 } })!.amount, 0);
});
ok("kit inicial com 60% de domínio", () => {
  assert.ok(startingKit(rs, "estudante").every((a) => a.progress === 60));
});

// ---------- nível de poder, pontos, teto ----------
ok("nível de poder pela XP (separado do cargo)", () => {
  const lv = (xp: number) => powerLevel(rs, xp).level!.label;
  assert.equal(lv(0), "Estudante");
  assert.equal(lv(99), "Estudante");
  assert.equal(lv(100), "Genin");
  assert.equal(lv(599), "Genin");
  assert.equal(lv(600), "Chunin");
  assert.equal(lv(1500), "Jounin Especial");
  assert.equal(lv(8000), "Kage");
  assert.equal(powerLevel(rs, 0).next!.xpRequired, 100);
  assert.equal(attributeCap(rs, 0, "ninjutsu"), 5);
  assert.equal(attributeCap(rs, 3000, "ninjutsu"), 9);
});
ok("rulesets antigos sem powerLevels usam os ranks (sem teto)", () => {
  const old = { ...rs, powerLevels: undefined };
  assert.equal(powerLevel(old, 100).level!.label, "Genin");
  assert.equal(attributeCap(old, 0, "ninjutsu"), 10);
});
const sheet = (): Sheet => ({ ...blankSheet(rs), attributes: { ...blankSheet(rs).attributes, ninjutsu: 5, vigor: 6 } });
ok("pontos livres: 1 a cada 50 XP, menos os gastos", () => {
  const s = sheet();
  assert.deepEqual(attributePoints(rs, s), { earned: 0, spent: 0, free: 0 });
  s.xp = 149;
  assert.equal(attributePoints(rs, s).free, 2);
  s.attrPointsSpent = 2;
  assert.equal(attributePoints(rs, s).free, 0);
  s.xp = 0; // XP perdida não deixa saldo negativo
  assert.equal(attributePoints(rs, s).free, 0);
});
ok("teto: atributo da criação acima do teto fica, mas não sobe", () => {
  const s = sheet(); // vigor 6 com teto 5 (Estudante)
  assert.match(raiseBlocked(rs, s, "vigor", 7)!, /aguarda o nível Chunin/);
  assert.equal(raiseBlocked(rs, s, "vigor", 4), null, "reduzir é livre");
  assert.match(raiseBlocked(rs, s, "ninjutsu", 6)!, /aguarda o nível Genin/);
  assert.equal(raiseBlocked(rs, s, "taijutsu", 4), null);
  s.xp = 100; // Genin: teto 6
  assert.equal(raiseBlocked(rs, s, "ninjutsu", 6), null);
  assert.match(raiseBlocked(rs, s, "vigor", 7)!, /Chunin/);
});

// ---------- treino (puro) ----------
ok("treino de jutsu: por hora, rendimento menor no alto, teto diário", () => {
  const s = sheet();
  s.abilities = [{ name: "Bunshin", type: "ninjutsu", rank: "D", progress: 60 }];
  const r = train(rs, s, "bunshin", 3, 1);
  assert.ok(!("error" in r) && r.kind === "ability");
  assert.equal(s.abilities[0].progress, 66); // 2/h na faixa 50-74
  const r2 = train(rs, s, "Bunshin", 7, 1);
  assert.ok(!("error" in r2) && r2.kind === "ability");
  // 66→68→70→72→74→76→77→78 = +12, mas o teto diário é 25 (já tinha +6): cabe
  assert.equal(s.abilities[0].progress, 78);
  assert.equal(s.trainingLog!.hours, 10);
  const r3 = train(rs, s, "Bunshin", 1, 1);
  assert.ok("error" in r3 && /exausto/.test(r3.error), "11ª hora no mesmo dia é recusada");
  const r4 = train(rs, s, "Bunshin", 1, 2); // dia seguinte zera
  assert.ok(!("error" in r4));
  assert.equal(s.trainingLog!.day, 2);
});
ok("treino de jutsu corta no teto diário de domínio", () => {
  const s = sheet();
  s.abilities = [{ name: "Henge", type: "ninjutsu", rank: "D", progress: 0 }];
  const r = train(rs, s, "Henge", 10, 1); // 3/h até 50 → +30, corta em 25
  assert.ok(!("error" in r) && r.kind === "ability" && r.capped);
  assert.equal(s.abilities[0].progress, 25);
  s.trainingLog!.hours = 0; // horas livres, domínio do dia esgotado
  const r2 = train(rs, s, "Henge", 1, 1);
  assert.ok("error" in r2 && /máximo de domínio hoje/.test(r2.error));
});
ok("treino de atributo: 20 h x valor, respeita o teto", () => {
  const s = sheet();
  s.attributes.taijutsu = 3; // +1 exige 60 h
  for (let d = 1; d <= 6; d++) train(rs, s, "taijutsu", 10, d);
  assert.equal(s.attributes.taijutsu, 4);
  assert.equal(s.trainingHours!.taijutsu, 0);
  const r = train(rs, s, "Taijutsu", 10, 7); // rótulo também vale
  assert.ok(!("error" in r) && r.kind === "attribute" && r.banked === 10 && r.need === 80);
  const capped = train(rs, s, "vigor", 2, 8); // vigor 6 > teto 5
  assert.ok("error" in capped && /aguarda o nível/.test(capped.error));
  assert.equal(s.attributes.vigor, 6);
});
ok("treino de alvo inexistente explica", () => {
  const r = train(rs, sheet(), "Rasengan", 2, 1);
  assert.ok("error" in r && /add_ability/.test(r.error));
});

// ---------- ferramentas no banco ----------
async function dbChecks() {
  const [camp] = await q<Campaign>(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('progression-check (teste)', 'hybrid', $1, $2) RETURNING *`,
    [JSON.stringify(rs), JSON.stringify({ clock: { minutes: 8 * 60 } })]
  );
  try {
    const s = sheet();
    s.abilities = startingKit(rs, "estudante");
    s.abilities.push({ name: "Katon Novo", type: "ninjutsu", rank: "C", progress: 10 });
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet, persona) VALUES ($1,'player','Teste',$2,'{}')`, [camp.id, JSON.stringify(s)]);
    const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq, mode, title) VALUES ($1,1,'training','t') RETURNING *`, [camp.id]);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: camp, scene, emit: (e) => events.push(e) };
    const run = (name: string, args: Record<string, unknown>) => executeGmTool(name, args, ctx);
    const char = async () => (await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [camp.id]))[0];

    // use_ability: Katon C (6) com 10% → 9 de chakra; ninjutsu 5 x2 + domínio 0 = +10
    let out = await run("use_ability", { character: "Teste", ability: "katon novo", dc: 18, target: "tronco" });
    let c = await char();
    const dice = events.find((e) => e.type === "dice");
    assert.ok(dice && dice.type === "dice", "evento de dados emitido");
    assert.equal(dice.result.modifier, 10);
    assert.equal(dice.result.dc, 18);
    assert.equal(c.sheet.resources.chakra.current, 50 - 9);
    assert.equal(c.sheet.abilities.find((a) => a.name === "Katon Novo")!.progress, 15); // +5 na faixa < 25
    assert.match(out, /Custo pago: 9 chakra \(base 6, \+50% pelo domínio\)/);
    console.log(`✔ use_ability: ${out}`);
    n++;

    // Henge (custo próprio 3, 60%): +2 no teste; selos? não, ninjutsu (tipo)
    events.length = 0;
    out = await run("use_ability", { character: "Teste", ability: "Henge no Jutsu", dc: 14 });
    assert.equal((events.find((e) => e.type === "dice") as { result: { modifier: number } }).result.modifier, 12);
    c = await char();
    assert.equal(c.sheet.resources.chakra.current, 41 - 3);
    assert.equal(c.sheet.abilities.find((a) => a.name === "Henge no Jutsu")!.progress, 63);
    // override de atributo
    events.length = 0;
    await run("use_ability", { character: "Teste", ability: "Henge no Jutsu", attribute: "selos", dc: 14 });
    assert.equal((events.find((e) => e.type === "dice") as { result: { modifier: number } }).result.modifier, 3 * 2 + 2);
    // não está na ficha
    assert.match(await run("use_ability", { character: "Teste", ability: "Rasengan", dc: 20 }), /add_ability/);
    // sem chakra: falha sem rolar
    await run("update_resource", { character: "Teste", resource: "chakra", set: 2 });
    events.length = 0;
    assert.match(await run("use_ability", { character: "Teste", ability: "Katon Novo", dc: 18 }), /FALHOU sem rolar/);
    assert.ok(!events.some((e) => e.type === "dice"));
    assert.equal((await char()).sheet.resources.chakra.current, 2);
    ok("use_ability: bônus do domínio, override de atributo, erro sem ficha, falha sem recurso", () => {});

    // train avança o relógio e respeita o limite diário
    events.length = 0;
    out = await run("train", { character: "Teste", target: "Bunshin no Jutsu", hours: 4 });
    const [st] = await q<{ state: { clock: { minutes: number } } }>(`SELECT state FROM campaigns WHERE id = $1`, [camp.id]);
    assert.equal(st.state.clock.minutes, 12 * 60);
    assert.ok(events.some((e) => e.type === "time" && e.minutes === 12 * 60));
    assert.equal((await char()).sheet.abilities.find((a) => a.name === "Bunshin no Jutsu")!.progress, 68);
    assert.match(await run("train", { character: "Teste", target: "taijutsu", hours: 7 }), /exausto/);
    assert.equal((await q<{ state: { clock: { minutes: number } } }>(`SELECT state FROM campaigns WHERE id = $1`, [camp.id]))[0].state.clock.minutes, 12 * 60, "recusa não mexe no relógio");
    await run("train", { character: "Teste", target: "taijutsu", hours: 6 });
    assert.equal((await char()).sheet.trainingHours!.taijutsu, 6);
    ok(`train: relógio 08:00 → 12:00 → 18:00, limite de 10 h/dia (${out.slice(0, 60)}...)`, () => {});

    // update_attribute respeita o teto
    assert.match(await run("update_attribute", { character: "Teste", attribute: "ninjutsu", value: 6 }), /recusado.*Genin/);
    assert.match(await run("update_attribute", { character: "Teste", attribute: "vigor", value: 7 }), /recusado/);
    assert.match(await run("update_attribute", { character: "Teste", attribute: "vigor", value: 4 }), /atualizado/);
    assert.equal((await char()).sheet.attributes.vigor, 4);
    ok("update_attribute: recusa acima do teto, reduz livre", () => {});

    // grant_xp anuncia nível de poder e pontos, sem pedir promoção
    out = await run("grant_xp", { character: "Teste", amount: 120 });
    assert.match(out, /NÍVEL DE PODER SUBIU para Genin/);
    assert.match(out, /\+2 ponto\(s\) livre\(s\)/);
    assert.doesNotMatch(out, /promova/);
    assert.equal((await char()).sheet.rank, "estudante", "cargo não muda");
    assert.equal(attributeCap(rs, (await char()).sheet.xp, "ninjutsu"), 6);
    assert.match(await run("update_attribute", { character: "Teste", attribute: "ninjutsu", value: 6 }), /atualizado/);
    ok("grant_xp: nível de poder sobe sozinho, cargo fica", () => {});
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [camp.id]);
  }
}

dbChecks()
  .then(() => console.log(`\n${n} checagens OK`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());

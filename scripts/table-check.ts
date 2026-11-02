/**
 * Verificação das regras da mesa: CD efetiva, críticos, validação, ferramentas do Mestre e
 * "gerar novamente" (a regra fica). Campanha temporária, sem IA. Rodar: npx tsx scripts/table-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { rollDice } from "../src/lib/dice";
import { executeGmTool, saveTable, ToolContext } from "../src/lib/tools";
import { DEFAULT_TABLE, getTable, mergeCategories, normalizeTable, restRuleText, tableDc, tablePromptBlock, xpRule, xpRuleText, MODE_HINTS, modeHint } from "../src/lib/table";
import { runTool } from "../src/lib/ooc";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import type { Campaign, DiceResult, Scene, TableRules, TurnEvent } from "../src/lib/types";

const ok = (t: TableRules | string) => {
  assert.equal(typeof t, "object", String(t));
  return t as TableRules;
};

async function main() {
  // padrão e presets
  assert.deepEqual(getTable({}), DEFAULT_TABLE);
  const hard = ok(normalizeTable({ difficulty: "hard" }, DEFAULT_TABLE));
  assert.equal(hard.dcOffset, 2, "preset traz o ajuste dele");
  assert.equal(ok(normalizeTable({ difficulty: "brutal", dcOffset: 3 }, DEFAULT_TABLE)).dcOffset, 3, "ajuste explícito vence o preset");
  // ritmo de XP: padrão 5–10%/25%, patch parcial mantém o resto, ordem min ≤ max ≤ great
  assert.deepEqual(xpRule(DEFAULT_TABLE), { min: 5, max: 10, great: 25 });
  assert.deepEqual(ok(normalizeTable({ xp: { great: 40 } }, DEFAULT_TABLE)).xp, { min: 5, max: 10, great: 40 }, "parcial");
  assert.equal(typeof normalizeTable({ xp: { min: 12 } }, DEFAULT_TABLE), "string", "min acima do max é recusado");
  assert.equal(typeof normalizeTable({ xp: { great: 101 } }, DEFAULT_TABLE), "string", "acima de 100 é recusado");
  assert.match(xpRuleText({ ...DEFAULT_TABLE, xp: { min: 2, max: 5, great: 12 } }), /de 2 a 5% .* até 12%/);
  // modos de cena: parcial, texto igual ao padrão ou vazio volta ao padrão, modo desconhecido é recusado
  const m1 = ok(normalizeTable({ modes: { dialogue: "Diálogos longos e descritivos." } }, DEFAULT_TABLE));
  assert.equal(modeHint(m1, "dialogue"), "Diálogos longos e descritivos.");
  assert.equal(modeHint(m1, "battle"), MODE_HINTS.battle, "os outros seguem o padrão");
  const m2 = ok(normalizeTable({ modes: { battle: "Batalhas cruas." } }, m1));
  assert.deepEqual(Object.keys(m2.modes ?? {}).sort(), ["battle", "dialogue"], "parcial mantém os outros ajustes");
  assert.equal(ok(normalizeTable({ modes: { dialogue: "", battle: MODE_HINTS.battle } }, m2)).modes, undefined, "vazio ou igual ao padrão volta ao padrão");
  assert.equal(typeof normalizeTable({ modes: { stealth: "x" } }, DEFAULT_TABLE), "string", "modo desconhecido é recusado");
  assert.equal(ok(normalizeTable({ crits: true }, hard)).dcOffset, 2, "patch parcial mantém o resto");
  // descanso: key que não é recurso sai, min > max vira a faixa certa, um número só vale para os dois, null e vazio tiram
  const keys = ["hp", "chakra", "stamina"];
  const r1 = ok(normalizeTable({ rest: { light: { chakra: { min: 5, max: 3 }, voo: { min: 1, max: 2 }, stamina: { min: 6 } } } }, DEFAULT_TABLE, keys));
  assert.deepEqual(r1.rest, { light: { chakra: { min: 3, max: 5 }, stamina: { min: 6, max: 6 } } });
  assert.equal(restRuleText(r1), "descanso leve (refeição, pausa): chakra +3 a 5, stamina +6");
  assert.equal(restRuleText(DEFAULT_TABLE), "", "sem regra, sem texto");
  const r2 = ok(normalizeTable({ rest: { full: { hp: { min: 10, max: 20 } } } }, r1, keys));
  assert.deepEqual(Object.keys(r2.rest ?? {}), ["light", "full"], "cada tipo substitui só o dele");
  assert.equal(ok(normalizeTable({ rest: { light: { chakra: null }, full: {} } }, r2, keys)).rest, undefined, "tudo vazio = sem regra");
  assert.equal(ok(normalizeTable({ rest: { light: { chakra: { min: 3, max: 5 } } } }, DEFAULT_TABLE)).rest, undefined, "sem recursos no mundo, nada entra");
  assert.match(normalizeTable({ rest: { light: { hp: { min: -1, max: 2 } } } }, DEFAULT_TABLE, keys) as string, /rest/);
  assert.match(normalizeTable({ rest: { light: { hp: { min: 1.5, max: 2 } } } }, DEFAULT_TABLE, keys) as string, /rest/);
  assert.match(normalizeTable({ rest: { nap: {} } }, DEFAULT_TABLE, keys) as string, /tipo de descanso/);

  // validação
  assert.match(normalizeTable({ difficulty: "impossivel" }, DEFAULT_TABLE) as string, /difficulty/);
  assert.match(normalizeTable({ dcOffset: 11 }, DEFAULT_TABLE) as string, /dcOffset/);
  assert.match(normalizeTable({ dcOffset: 1.5 }, DEFAULT_TABLE) as string, /dcOffset/);
  assert.match(normalizeTable({ crits: "sim" }, DEFAULT_TABLE) as string, /crits/);
  assert.match(normalizeTable({ categories: [{ label: "", offset: 1 }] }, DEFAULT_TABLE) as string, /label/);
  assert.match(normalizeTable({ categories: [{ label: "A", offset: 20 }] }, DEFAULT_TABLE) as string, /offset/);
  assert.match(normalizeTable({ categories: [{ label: "Combate", offset: 1 }, { key: "combate", label: "Luta", offset: 2 }] }, DEFAULT_TABLE) as string, /repetida/);
  assert.match(normalizeTable({ notes: "x".repeat(601) }, DEFAULT_TABLE) as string, /notes/);
  const t = ok(normalizeTable({ categories: [{ label: "Combate", offset: 3 }, { label: "Furtividade Noturna", offset: -2 }], crits: true }, hard));
  assert.deepEqual(t.categories.map((c) => c.key), ["combate", "furtividade_noturna"], "key vem do label");
  assert.equal(ok(normalizeTable({ notes: "  " }, { ...t, notes: "antiga" })).notes, undefined, "notes vazio apaga");

  // fora do jogo: cria/muda/tira sem mandar a lista inteira
  const merged = ok(normalizeTable({ categories: mergeCategories(t.categories, [{ label: "combate", offset: 5 }, { label: "Social", offset: -1 }], ["furtividade_noturna"]) }, t));
  assert.deepEqual(merged.categories, [{ key: "combate", label: "Combate", offset: 5 }, { key: "social", label: "Social", offset: -1 }]);

  // CD efetiva
  assert.deepEqual(tableDc(DEFAULT_TABLE, 15, undefined), { dc: 15, dice: {}, note: "" }, "sem ajuste, nada muda");
  let a = tableDc(t, 15, "combate");
  assert.equal(a.dc, 20);
  assert.deepEqual(a.dice, { baseDc: 15, dcAdjust: [{ label: "Difícil", value: 2 }, { label: "Combate", value: 3 }] });
  assert.match(a.note, /CD base 15 \+2 Difícil \+3 Combate = 20; ajuste da mesa já aplicado/);
  a = tableDc(t, 15, "Furtividade Noturna");
  assert.equal(a.dc, 15, "categoria pelo label");
  a = tableDc(t, 15, "voo");
  assert.equal(a.dc, 17);
  assert.match(a.note, /"voo" não existe/);
  assert.equal(tableDc(ok(normalizeTable({ difficulty: "story" }, DEFAULT_TABLE)), 3, undefined).dc, 1, "CD mínima 1");
  assert.equal(tableDc(t, undefined, "combate").dc, undefined, "disputa: sem CD");

  // críticos: só 1d20 com CD e com a regra ligada
  const roll = (want: number, notation: string, dc: number, crits: boolean): DiceResult => {
    for (;;) {
      const r = rollDice(notation, "", dc, crits);
      if (r.rolls[0] === want) return r;
    }
  };
  let r = roll(20, "1d20", 99, true);
  assert.deepEqual([r.success, r.crit], [true, "success"], "20 natural passa");
  r = roll(1, "1d20+30", 5, true);
  assert.deepEqual([r.success, r.crit], [false, "failure"], "1 natural falha");
  r = roll(20, "1d20", 99, false);
  assert.deepEqual([r.success, r.crit], [false, undefined], "sem a regra, só o total");
  r = roll(20, "2d20", 99, true);
  assert.equal(r.crit, undefined, "só em 1d20");
  assert.equal(rollDice("1d20", "", undefined, true).crit, undefined, "sem CD não há crítico");
  // garantido: o dado não muda o desfecho (sem animação no cliente)
  assert.equal(rollDice("1d20+13", "", 14).sure, true, "o 1 já passa");
  assert.equal(rollDice("1d20+13", "", 14).success, true);
  assert.equal(rollDice("1d20+12", "", 14).sure, undefined, "o 1 falharia");
  assert.equal(rollDice("1d20+2", "", 23).sure, true, "nem o 20 alcança");
  assert.equal(rollDice("1d20+2", "", 23).success, false);
  assert.equal(rollDice("1d20+13", "", 14, true).sure, undefined, "com críticos o 1 natural ainda falha");
  assert.equal(rollDice("2d6+12", "", 14, true).sure, true, "crítico só vale no 1d20");
  assert.equal(rollDice("1d20+30").sure, undefined, "sem CD não há garantido");

  // bloco do prompt
  const block = tablePromptBlock(t);
  assert.match(block, /REGRAS DA MESA/);
  assert.match(block, /trivial 5, fácil 10, médio 15, difícil 20, muito difícil 25, quase impossível 30/);
  assert.match(block, /Difícil \(CD \+2\)/);
  assert.match(block, /combate \(Combate\) \+3/);
  assert.match(block, /20 natural passa/);

  // ferramentas do Mestre e "gerar novamente"
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-mesa]', '{}') RETURNING id`);
  const id = c.id;
  try {
    const ruleset = { attributes: [{ key: "forca", label: "Força" }], resources: [], attributeMultiplier: 1 };
    await q(
      `INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`,
      [id, JSON.stringify({ attributes: { forca: 2 }, resources: {}, abilities: [{ name: "Soco", type: "forca", progress: 50 }], inventory: [], xp: 0, extra: {} })]
    );
    await saveTable(id, t);
    const [{ state }] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: { id, state, ruleset } as unknown as Campaign, scene: {} as Scene, emit: (e) => events.push(e) };
    const dice = () => (events.filter((e) => e.type === "dice").pop() as { result: DiceResult }).result;

    let out = await executeGmTool("roll_dice", { notation: "1d20+4", dc: 15, category: "combate", reason: "ataque" }, ctx);
    assert.match(out, /contra CD 20 \(CD base 15 \+2 Difícil \+3 Combate = 20/);
    assert.deepEqual([dice().dc, dice().baseDc], [20, 15]);
    out = await executeGmTool("use_ability", { character: "Hugo", ability: "Soco", dc: 12, category: "social" }, ctx);
    assert.match(out, /contra CD 14 \(CD base 12 \+2 Difícil = 14.*"social" não existe/);
    assert.equal(dice().dc, 14);
    out = await executeGmTool("roll_dice", { notation: "1d20" }, ctx);
    assert.doesNotMatch(out, /CD/, "disputa sem CD");

    // fora do jogo: set_table_rules com rest muda só o recurso que veio (null tira) e confirma em texto
    const rctx = { ...ctx, campaign: { ...ctx.campaign, ruleset: { ...ruleset, resources: [{ key: "chakra" }, { key: "stamina" }] } } } as unknown as Parameters<typeof runTool>[2];
    out = await runTool("set_table_rules", JSON.stringify({ rest: { light: { chakra: { min: 3, max: 5 }, stamina: { min: 5, max: 8 }, mana: { min: 1, max: 2 } } } }), rctx, []);
    assert.match(out, /^✓ Regras da mesa: .*descanso: descanso leve \(refeição, pausa\): chakra \+3 a 5, stamina \+5 a 8/);
    out = await runTool("set_table_rules", JSON.stringify({ rest: { light: { chakra: { min: 2, max: 4 }, stamina: null } } }), rctx, []);
    const [saved] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
    assert.deepEqual(getTable(saved.state).rest, { light: { chakra: { min: 2, max: 4 } } }, "merge por recurso, null tira");
    assert.equal(getTable(saved.state).difficulty, "hard", "o resto da mesa fica");
    out = await runTool("set_table_rules", JSON.stringify({ rest: { light: { chakra: { min: -2, max: 4 } } } }), rctx, []);
    assert.match(out, /^Erro: rest/);
    await saveTable(id, t);

    // o jogador muda a regra depois do turno: gerar novamente não volta a regra antiga
    await q(`UPDATE campaigns SET state = state || '{"theme":"neon"}' WHERE id = $1`, [id]);
    await takeSnapshot(id, "ataco");
    await saveTable(id, DEFAULT_TABLE);
    await q(`UPDATE campaigns SET state = state - 'theme' WHERE id = $1`, [id]);
    await restoreSnapshot(id);
    const [after] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
    assert.deepEqual(getTable(after.state), DEFAULT_TABLE);
    assert.equal(after.state.theme, undefined, "tema também fica como está");

    console.log("table-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

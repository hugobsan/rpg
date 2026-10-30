/**
 * Verificação das regras da mesa: CD efetiva, críticos, validação, ferramentas do Mestre e
 * "gerar novamente" (a regra fica). Campanha temporária, sem IA. Rodar: npx tsx scripts/table-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { rollDice } from "../src/lib/dice";
import { executeGmTool, saveTable, ToolContext } from "../src/lib/tools";
import { DEFAULT_TABLE, getTable, mergeCategories, normalizeTable, tableDc, tablePromptBlock } from "../src/lib/table";
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
  assert.equal(ok(normalizeTable({ crits: true }, hard)).dcOffset, 2, "patch parcial mantém o resto");

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

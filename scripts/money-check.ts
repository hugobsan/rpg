/**
 * Dinheiro, sem IA: moedas do mundo (uma ou várias), update_money, pagamento de missão ao concluir (uma vez) e o painel
 * devolvendo ao reabrir. Cria uma campanha temporária. Rodar: npx tsx scripts/money-check.ts
 */
import assert from "node:assert/strict";
import { q } from "../src/lib/db";
import { formatMoney, normalizeCurrency, toBase } from "../src/lib/money";
import { executeGmTool, ToolContext } from "../src/lib/tools";
import { applyFix } from "../src/lib/corrections";
import { getObjectives } from "../src/lib/objectives";
import type { Campaign, Currency, Scene } from "../src/lib/types";

async function main() {
  // várias moedas: ordem por valor, troco automático, plural e nome por key, label ou plural
  const hp = normalizeCurrency({ units: [{ key: "nuque", label: "Nuque", plural: "Nuques", value: 1 }, { key: "galeao", label: "Galeão", plural: "Galeões", value: 493 }, { key: "sicle", label: "Sicle", plural: "Sicles", value: 29 }, { key: "x", label: "", value: 2 }] })!;
  assert.deepEqual(hp.units.map((u) => u.key), ["galeao", "sicle", "nuque"], "inválida fora, da maior para a menor");
  assert.equal(formatMoney(2 * 493 + 3 * 29 + 5, hp), "2 Galeões, 3 Sicles e 5 Nuques");
  assert.equal(formatMoney(493 + 1, hp), "1 Galeão e 1 Nuque");
  assert.equal(formatMoney(0, hp), "0 Nuques");
  assert.equal(toBase(2, "Galeões", hp), 986);
  assert.equal(toBase(1, "galeao", hp), 493);
  assert.match(String(toBase(1, undefined, hp)), /use unit/, "várias moedas: precisa dizer qual");
  const ryo: Currency = normalizeCurrency({ units: [{ key: "ryo", label: "Ryō", value: 1 }], start: 1000 })!;
  assert.equal(formatMoney(45850, ryo), "45.850 Ryō");
  assert.equal(toBase(500, undefined, ryo), 500, "uma moeda só: unit opcional");
  assert.equal(normalizeCurrency({ units: [] }), undefined);

  const ruleset = { name: "t", resources: [], attributes: [], ranks: [], abilityRanks: [], currency: ryo };
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset, script, state) VALUES ('[teste-dinheiro]', $1, '{"arcs":[]}', '{}') RETURNING id`, [JSON.stringify(ruleset)]);
  const id = c.id;
  const chips: string[] = [];
  const ctx: ToolContext = { campaign: { id, state: {}, ruleset } as unknown as Campaign, scene: {} as Scene, emit: (e) => void (e.type === "tool" && chips.push(e.summary)) };
  const run = (name: string, args: Record<string, unknown>) => executeGmTool(name, args, ctx);
  const money = async () => (await q<{ m: number }>(`SELECT (sheet->>'money')::int AS m FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [id]))[0].m;
  try {
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', '{"attributes":{},"resources":{},"abilities":[],"inventory":[],"xp":0,"extra":{},"money":1000}')`, [id]);
    assert.match(await run("update_money", { character: "Hugo", amount: -400, reason: "kunai" }), /600 Ryō/);
    assert.match(chips.at(-1)!, /💰 Hugo: −400 Ryō \(kunai\) → 600 Ryō/);
    assert.match(await run("update_money", { character: "Hugo", amount: -700, reason: "caro" }), /^Nada mudou.*600 Ryō/, "não gasta o que não tem");
    assert.equal(await money(), 600);

    // missão com a parte do jogador: paga ao concluir, uma vez, e o texto avisa para não registrar de novo
    await run("add_objective", { title: "Gata", kind: "missao", description: "achar a gata", pay: 5000, reward: "10 mil ryō para a equipe", status: "oferecida" });
    assert.equal(getObjectives((await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]))[0].state)[0].pay, 5000);
    await run("update_objective", { objective: "o1", status: "aberto" });
    assert.match(await run("update_objective", { objective: "o1", status: "concluido" }), /Pagamento de 5\.000 Ryō.*não registre de novo/);
    assert.equal(await money(), 5600);
    assert.match(chips.at(-1)!, /Concluído: Gata \(\+5\.000 Ryō\)/);

    // painel: reabrir devolve o pagamento; concluir de novo paga de novo
    await applyFix(id, { fix: "objective", objective: "o1", status: "aberto" });
    assert.equal(await money(), 600, "reabrir devolve");
    await applyFix(id, { fix: "objective", objective: "o1", status: "concluido" });
    assert.equal(await money(), 5600, "concluir pelo painel paga");
    console.log("money-check: ok (uma ou várias moedas com troco, update_money recusa gasto sem saldo, missão paga a parte do jogador ao concluir uma vez, painel devolve e paga)");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

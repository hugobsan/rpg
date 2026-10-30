/**
 * Checagem da biblioteca (lib/library.ts) sem IA: validação da saída do Criador, leitura do JSON,
 * fallback do add_ability, lotes com dedup e parada, e as ferramentas do Mestre (add_ability com a
 * técnica da biblioteca, add_item, search_library). Campanha temporária apagada no fim.
 *
 *   npx tsx scripts/library-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pool, q } from "../src/lib/db";
import { normalizeRuleset, blankSheet } from "../src/lib/ruleset";
import { fallbackAbility, fillLibrary, listLibrary, normalizeAbility, normalizeItem, parseCreatorJson } from "../src/lib/library";
import { executeGmTool, type ToolContext } from "../src/lib/tools";
import type { Campaign, Character, LibraryAbility, Scene, TurnEvent } from "../src/lib/types";

const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
let n = 0;
const ok = (label: string) => console.log(`✔ ${label} (${++n})`);

// ---------- validação ----------
{
  const a = normalizeAbility(rs, {
    name: "  Chidori ",
    type: "Ninjutsu", // label vira key
    rank: "a",
    cost: { resource: "Chakra", amount: "20" },
    damage: "3D8 + 2",
    milestones: [
      { threshold: 50, description: "Corta jutsus de raio inferiores" },
      { threshold: -5, description: "Golpe perfurante em linha reta" },
      { threshold: 50, description: "repetido" },
      { threshold: 140, description: "Chidori Nagashi" },
      { threshold: 30 },
    ],
    users: "Kakashi, Sasuke",
    canon: true,
    extra: "ignorado",
  });
  assert.deepEqual(a, {
    name: "Chidori",
    type: "ninjutsu",
    rank: "A",
    cost: { resource: "chakra", amount: 20 },
    damage: "3d8+2",
    users: "Kakashi, Sasuke",
    milestones: [
      { threshold: 0, description: "Golpe perfurante em linha reta" },
      { threshold: 50, description: "Corta jutsus de raio inferiores" },
      { threshold: 100, description: "Chidori Nagashi" },
    ],
  });
  assert.equal(normalizeAbility(rs, { name: "X", type: "magia" }), null, "tipo fora do ruleset");
  assert.equal(normalizeAbility(rs, { type: "ninjutsu" }), null, "sem nome");
  const loose = normalizeAbility(rs, { name: "Y", type: "taijutsu", rank: "E", cost: { resource: "mana", amount: 3 }, damage: "muito" })!;
  assert.deepEqual(loose, { name: "Y", type: "taijutsu" }, "rank, recurso e dano inválidos caem fora");
  assert.equal(normalizeAbility(rs, { name: "Z", type: "genjutsu", cost: { resource: "chakra", amount: -2 } })!.cost, undefined);
  assert.deepEqual(normalizeAbility(rs, { name: "P", type: "genjutsu", cost: { resource: "chakra", amount: 0 } })!.cost, { resource: "chakra", amount: 0 });
  assert.deepEqual(normalizeItem(rs, { name: "Kunai", category: "arma", damage: "1d4", rank: "z", qty: 3 }), { name: "Kunai", category: "arma", damage: "1d4" });
  assert.equal(normalizeItem(rs, { category: "arma" }), null);
  ok("normalização: tipo/rank/recurso pelo ruleset, dado, marcos ordenados e sem repetição");
}
{
  const items = [{ name: "A" }, { name: "B" }];
  assert.deepEqual(parseCreatorJson('<think>{"rascunho": 1}</think>\n```json\n{"items": [{"name": "A"}, {"name": "B"},]}\n```'), items);
  assert.deepEqual(parseCreatorJson('Aqui está: [{"name": "A"}, {"name": "B"}]'), items);
  assert.deepEqual(parseCreatorJson('{"name": "A"}'), [{ name: "A" }]);
  assert.deepEqual(parseCreatorJson("não sei"), []);
  assert.deepEqual(parseCreatorJson('{"items": [{"name": "A"'), []);
  ok("leitura do JSON: cercas, <think>, vírgula sobrando, lista solta, entrada única, lixo");
}
{
  assert.deepEqual(fallbackAbility(rs, "Golpe Novo", { abilityType: "magia", brief: "um soco rápido" }), {
    name: "Golpe Novo", type: "ninjutsu", description: "um soco rápido",
  });
  // argumentos antigos (prompt do Mestre de antes) ainda valem, validados
  assert.deepEqual(fallbackAbility(rs, "Katon X", { abilityType: "ninjutsu", rank: "C", cost: { resource: "chakra", amount: 7 }, damage: "2d6" }), {
    name: "Katon X", type: "ninjutsu", rank: "C", cost: { resource: "chakra", amount: 7 }, damage: "2d6",
  });
  assert.deepEqual(fallbackAbility({ ...rs, abilityTypes: [] }, "Q", {}), { name: "Q", type: "geral" });
  ok("fallback do add_ability: tipo válido ou o primeiro, brief vira descrição");
}

// ---------- banco ----------
async function db() {
  const [camp] = await q<Campaign>(
    `INSERT INTO campaigns (name, style, ruleset, state) VALUES ('[teste-biblioteca] check', 'hybrid', $1, '{}') RETURNING *`,
    [JSON.stringify(rs)]
  );
  try {
    const ab = (name: string, extra: Partial<LibraryAbility> = {}) => ({ data: { name, type: "ninjutsu", rank: "D", ...extra }, canon: true });
    await q(`INSERT INTO library (campaign_id, kind, name, data, canon) VALUES ($1, 'ability', 'Henge no Jutsu', '{"name":"Henge no Jutsu","type":"ninjutsu"}', true)`, [camp.id]);

    // lote 1: um repetido da biblioteca (outra caixa/acento) e um repetido no próprio lote; lote 2 completa
    const asked: { want: number; existing: string[] }[] = [];
    const batches = [
      [ab("HENGE NO JUTSU"), ab("Bunshin"), ab("Kawarimi"), ab("Bunshin"), ab("Kai"), ab("Shunshin")],
      [ab("Kai"), ab("Tobidogu"), ab("Chidori", { rank: "A", cost: { resource: "chakra", amount: 20 }, users: "Kakashi", milestones: [{ threshold: 0, description: "golpe" }] }), ab("Sobra")],
    ];
    const prog: string[] = [];
    let done = await fillLibrary(camp.id, "ability", 6, async (want, existing) => {
      asked.push({ want, existing });
      return batches[asked.length - 1] ?? [];
    }, async (d, t) => void prog.push(`${d}/${t}`));
    assert.equal(done, 6);
    assert.deepEqual(asked.map((a) => a.want), [6, 2]);
    assert.ok(asked[1].existing.includes("Kawarimi") && asked[0].existing.includes("Henge no Jutsu"), "o lote seguinte recebe o que já existe");
    assert.deepEqual(prog, ["0/6", "4/6", "6/6"]);
    const names = (await listLibrary(camp.id, "ability")).map((e) => e.name);
    assert.deepEqual(names, ["Bunshin", "Chidori", "Henge no Jutsu", "Kai", "Kawarimi", "Shunshin", "Tobidogu"], "Sobra fica de fora");
    ok("lotes: dedup contra a biblioteca e dentro do lote, para no total, progresso");

    // 2 lotes seguidos sem nada novo = para
    let calls = 0;
    done = await fillLibrary(camp.id, "ability", 10, async () => (calls++, [ab("Kai"), ab("Bunshin")]), async () => {});
    assert.deepEqual([done, calls], [0, 2]);
    calls = 0;
    await assert.rejects(fillLibrary(camp.id, "item", 3, async () => { calls++; throw new Error("modelo fora"); }, async () => {}), /modelo fora/);
    assert.equal(calls, 2);
    ok("lotes: 2 seguidos repetidos ou com erro param (erro sem nada criado vira erro da tarefa)");

    // ferramentas do Mestre
    const sheet = blankSheet(rs);
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet, persona) VALUES ($1,'player','Teste',$2,'{}')`, [camp.id, JSON.stringify(sheet)]);
    const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq, mode, title) VALUES ($1,1,'battle','t') RETURNING *`, [camp.id]);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: camp, scene, emit: (e) => events.push(e) };
    const run = (name: string, args: Record<string, unknown>) => executeGmTool(name, args, ctx);
    const char = async () => (await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player'`, [camp.id]))[0];

    let out = await run("add_ability", { character: "Teste", name: "chidori", brief: "lâmina de raio", progress: 20 });
    assert.match(out, /adicionada \(da biblioteca\)/);
    assert.ok(!events.some((e) => e.type === "status"), "da biblioteca não chama o Criador");
    let chidori = (await char()).sheet.abilities[0];
    assert.deepEqual(chidori, {
      name: "Chidori", type: "ninjutsu", rank: "A", cost: { resource: "chakra", amount: 20 },
      milestones: [{ threshold: 0, description: "golpe" }], progress: 20,
    });
    out = await run("add_ability", { character: "Teste", name: "Chidori" });
    chidori = (await char()).sheet.abilities[0];
    assert.equal(chidori.progress, 20, "redefinir sem domínio mantém o domínio");
    assert.equal((await char()).sheet.abilities.length, 1);
    out = await run("use_ability", { character: "Teste", ability: "Chidori", dc: 18 });
    assert.match(out, /Custo pago: 30 chakra \(base 20/, "custo da biblioteca, ajustado pelo domínio");
    ok("add_ability: técnica da biblioteca na ficha, domínio mantido ao redefinir, use_ability com o custo dela");

    await q(
      `INSERT INTO library (campaign_id, kind, name, data, canon) VALUES ($1, 'item', 'Kunai', $2, true)`,
      [camp.id, JSON.stringify({ name: "Kunai", category: "arma", description: "Faca de arremesso.", damage: "1d4" })]
    );
    out = await run("add_item", { character: "Teste", name: "kunai", qty: 3 });
    assert.match(out, /da biblioteca/);
    assert.deepEqual((await char()).sheet.inventory, [{ name: "Kunai", qty: 3, description: "Faca de arremesso. Dano 1d4." }]);
    await run("add_item", { character: "Teste", name: "Pergaminho", description: "em branco" });
    assert.equal((await char()).sheet.inventory[1].description, "em branco");
    ok("add_item: descrição vem da biblioteca; item fora dela segue como antes");

    assert.match(await run("search_library", { kind: "ability", query: "kakashi" }), /^- Chidori \[ninjutsu, rank A, custo 20 chakra\].*usuários: Kakashi/);
    assert.match(await run("search_library", { kind: "ability" }), /^7 na biblioteca: Bunshin, Chidori/);
    assert.match(await run("search_library", { kind: "item", query: "nada" }), /Nada na biblioteca/);
    ok("search_library: por texto com custo e usuários; sem query, os nomes");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [camp.id]);
  }
}

db()
  .then(() => console.log(`\n${n} checagens OK`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool().end());

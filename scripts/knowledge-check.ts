/**
 * Memória por testemunha, sem IA: campanha temporária, efeitos aplicados por código (lib/effects) e o SABE de cada NPC
 * (lib/knowledge). Casos reais da campanha: Tenten e o javali (#3783: ela não viu, não sabe; o "só o jogador sabe" tem),
 * o jogador contando a ela (agora sabe, como "contaram"), fato público (NPC criado depois sabe), o Lojista de duas
 * lojas (#3777: não divide o que sabe), a conversa particular (só o jogador e o NPC) e o gerar novamente (apaga os
 * fatos do turno e quem ficou sabendo).
 * Rodar: npx tsx scripts/knowledge-check.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pool, q } from "../src/lib/db";
import { applyEffects } from "../src/lib/effects";
import { emptyEffects, localName, resolveName, validateEffects, type Effects, type EffectsCtx } from "../src/lib/contracts";
import { knownLine, knowsOf, pickKnown, recordTold, sameFact, sceneKnowledge, type Known } from "../src/lib/knowledge";
import { getCharacters, npcSpeeches, sabeBlock } from "../src/lib/engine";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import { blankSheet, normalizeRuleset } from "../src/lib/ruleset";
import type { Campaign, Scene } from "../src/lib/types";
import type { ToolContext } from "../src/lib/tools";

// sem rede: nenhum modelo é chamado (o Criador do NPC novo falha em segundo plano; embedding cai no full-text)
globalThis.fetch = (async () => {
  throw new Error("rede desligada no knowledge-check");
}) as typeof fetch;

let n = 0;
const ok = (msg: string) => (n++, console.log(`ok: ${msg}`));

function pure() {
  // fato contado casa com o que já existe pelas palavras, sem os nomes de quem conta e de quem ouve
  const javali = "Hugo e Genma caçaram o javali que destruía a horta da senhora Fuki";
  assert.ok(sameFact("Hugo caçou um javali na horta", javali, ["hugo", "tenten"]) >= 0.6, "mesmo fato");
  assert.equal(sameFact("Hugo comprou um tantō na loja", javali, ["hugo", "tenten"]), 0, "outro fato");
  assert.equal(sameFact("Hugo e Genma", javali, ["hugo"]), 0, "só nomes não bastam");

  // SABE: os 3 últimos testemunhados, metade por relevância, o resto por recência; em ordem cronológica
  const row = (id: number, access: Known["access"], score: number | null = null) => ({ id, text: `f${id}`, minute: null, access, from: null, score });
  const rows = [row(10, "told"), row(9, "witnessed"), row(8, "witnessed"), row(7, "witnessed"), row(6, "witnessed"), row(2, "told", 0.9), row(1, "witnessed", 0.5)];
  assert.deepEqual(pickKnown(rows, 5).map((k) => k.id), [1, 2, 7, 8, 9], "3 testemunhados + 2 relevantes");
  assert.deepEqual(pickKnown(rows, 6).map((k) => k.id), [1, 2, 7, 8, 9, 10], "o resto pelo mais recente");
  assert.equal(knownLine({ id: 1, text: "x", minute: 9 * 1440 + 15 * 60, access: "told", from: "Hugo" }), "- [Dia 10, tarde] x (contaram: Hugo)");
  assert.equal(knownLine({ id: 1, text: "x", minute: null, access: "public", from: null }), "- x (boato)");
  assert.match(sabeBlock([]), /nada da história/);

  // NPC genérico: um por lugar; a fala "**Lojista:**" vai ao Lojista deste lugar
  assert.equal(localName("Lojista", "Loja de armas"), "Lojista (Loja de armas)");
  assert.equal(localName("Genma", "Loja de armas"), "Genma");
  assert.equal(localName("Lojista (Loja de armas)", "Barraca"), "Lojista (Loja de armas)", "já tem o local");
  const npcs = ["Genma Shiranui", "Lojista (Loja de armas)", "Lojista (Barraca de ramen)", "Tenten"];
  assert.equal(resolveName(npcs, "Lojista", "Barraca de ramen"), "Lojista (Barraca de ramen)");
  assert.equal(resolveName(npcs, "Lojista", "Rua"), undefined, "genérico de outro lugar não casa pelo 1º nome");
  assert.equal(resolveName(npcs, "Genma"), "Genma Shiranui");
  const said = npcSpeeches(
    `A loja cheira a óleo.\n\n**Tenten:** "Isso aí não vai passar por pelo de javali."\n\n**Lojista:** "Leve o recibo."\n**Genma**: "Hm."\n**Viajante:** "Oi."`,
    npcs,
    "Loja de armas"
  );
  assert.deepEqual([...said.keys()], ["Tenten", "Lojista (Loja de armas)", "Genma Shiranui"], "quem não é registrado fica de fora");
  ok("puro: fato contado casa pelo texto, SABE escolhe e marca, NPC genérico por lugar, falas por NPC");
}

async function main() {
  pure();
  const rs = normalizeRuleset(JSON.parse(fs.readFileSync("naruto-ruleset.json", "utf-8")));
  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, state) VALUES ('[teste-conhecimento]', $1, '{"clock":{"minutes":${8 * 1440 + 15 * 60}}}') RETURNING id`,
    [JSON.stringify(rs)]
  );
  const id = c.id;
  try {
    const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq, location) VALUES ($1, 1, 'Horta da senhora Fuki') RETURNING *`, [id]);
    const sheet = JSON.stringify(blankSheet(rs));
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', $2)`, [id, sheet]);
    await q(`INSERT INTO characters (campaign_id, kind, name, sheet, active) VALUES ($1, 'npc', 'Genma', $2, TRUE), ($1, 'npc', 'Tenten', $2, FALSE)`, [id, sheet]);
    const ids = Object.fromEntries((await q<{ id: string; name: string }>(`SELECT id, name FROM characters WHERE campaign_id = $1`, [id])).map((r) => [r.name, r.id]));

    const ctxOf = async (): Promise<ToolContext> => ({
      campaign: (await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]))[0],
      scene: (await q<Scene>(`SELECT * FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1`, [id]))[0],
      emit: () => {},
    });
    // um turno: bloco validado como no engine e aplicado por código
    const turn = async (raw: Partial<Record<keyof Effects, unknown>>, audience?: string[]) => {
      const ctx = await ctxOf();
      const chars = await getCharacters(id);
      const fxCtx: EffectsCtx = {
        player: "Hugo",
        abilities: [],
        items: [],
        npcs: chars.filter((x) => x.kind === "npc").map((x) => x.name),
        missions: [],
        money: 1000,
        resourceWords: [],
        location: ctx.scene.location,
      };
      const { effects } = validateEffects({ ...emptyEffects(), ...raw }, fxCtx);
      const [m] = await q<{ id: number }>(`INSERT INTO messages (campaign_id, scene_id, role, content) VALUES ($1, $2, 'gm', 'narração') RETURNING id`, [id, ctx.scene.id]);
      await applyEffects(ctx, effects, { player: chars.find((x) => x.kind === "player")!, messageId: Number(m.id), audience });
      return effects;
    };
    const moveTo = async (location: string, present: string[]) => {
      await q(`UPDATE scenes SET location = $2 WHERE id = $1`, [scene.id, location]);
      await q(`UPDATE characters SET active = (name = ANY($2::text[])) WHERE campaign_id = $1 AND kind = 'npc'`, [id, present]);
    };
    const texts = (ks: Known[]) => ks.map((k) => k.text);

    // 1. a caçada: Hugo e Genma na horta
    await turn({ facts: [{ text: "Hugo e Genma caçaram o javali que destruía a horta da senhora Fuki" }] });
    const [jav] = await q<{ id: string }>(`SELECT id FROM events WHERE campaign_id = $1 AND text LIKE '%javali%'`, [id]);
    const who = await q<{ name: string; access: string }>(
      `SELECT c.name, k.access FROM knowledge k JOIN characters c ON c.id = k.character_id WHERE k.event_id = $1 ORDER BY c.name`,
      [jav.id]
    );
    assert.deepEqual(who, [{ name: "Genma", access: "witnessed" }, { name: "Hugo", access: "witnessed" }], "testemunhas = quem estava na cena");

    // 2. a loja de armas: Tenten em cena, Genma não. O SABE dela não tem o javali; o "só o jogador sabe" tem
    await moveTo("Loja de armas", ["Tenten"]);
    let mem = await sceneKnowledge(id, "Peço à Tenten para ver o tantō", [ids.Tenten], ids.Hugo);
    assert.ok(!texts(mem.sabe.get(ids.Tenten)!).some((t) => /javali/.test(t)), "Tenten não viu a caçada");
    assert.ok(texts(mem.onlyPlayer).some((t) => /javali/.test(t)), "o Narrador não esquece: só o jogador sabe");
    assert.ok(texts(await knowsOf(id, ids.Genma, "")).some((t) => /javali/.test(t)), "Genma viu");
    ok("Tenten e o javali: quem não viu não sabe; o Narrador lembra como 'só o jogador sabe'");

    // 3. o jogador conta à Tenten: casa com o fato que já existe e ela sabe como "contaram"
    await turn({ told: [{ fact: "Hugo caçou um javali na horta", by: "Hugo", to: ["Tenten"] }] });
    assert.equal((await q(`SELECT id FROM events WHERE campaign_id = $1`, [id])).length, 1, "não duplica o fato");
    mem = await sceneKnowledge(id, "javali", [ids.Tenten], ids.Hugo);
    const told = mem.sabe.get(ids.Tenten)!.find((k) => /javali/.test(k.text));
    assert.deepEqual([told?.access, told?.from], ["told", "Hugo"], "agora ela sabe: contaram");
    assert.ok(!texts(mem.onlyPlayer).some((t) => /javali/.test(t)), "deixou de ser só do jogador");
    assert.match(sabeBlock(mem.sabe.get(ids.Tenten)!), /javali.*\(contaram: Hugo\)/);
    // contar a quem não está na cena não vale
    assert.equal(await recordTold(id, "Hugo caçou um javali na horta", "Hugo", ["Genma"]), null, "Genma não está na loja");
    ok("o jogador contou: Tenten sabe como 'contaram: Hugo', sem fato duplicado; ausente não ouve");

    // 4. o Lojista da loja de armas: genérico ganha o local; a compra fica com quem viu
    await turn({ newNpcs: [{ name: "Lojista", gender: "m", brief: "dono da loja de armas" }], scene: { present: ["Lojista", "Tenten"] }, facts: [{ text: "Hugo comprou um tantō com bainha laqueada" }] });
    const lojaArmas = (await q<{ id: string; name: string }>(`SELECT id, name FROM characters WHERE campaign_id = $1 AND name LIKE 'Lojista%'`, [id]))[0];
    assert.equal(lojaArmas.name, "Lojista (Loja de armas)");

    // 5. anúncio público: quem entrar depois também sabe
    await turn({ facts: [{ text: "O Hokage anunciou o Exame Chūnin para o fim do mês", public: true }] });

    // 6. a barraca de ramen: outro Lojista, que não sabe da compra; Kiba, novo, sabe do anúncio
    await moveTo("Barraca de ramen", []);
    await turn({ newNpcs: [{ name: "Lojista", gender: "m", brief: "dono da barraca" }, { name: "Kiba", gender: "m", brief: "genin do Time 8" }], scene: { present: ["Lojista", "Kiba"] } });
    const lojistas = await q<{ id: string; name: string }>(`SELECT id, name FROM characters WHERE campaign_id = $1 AND name LIKE 'Lojista%' ORDER BY name`, [id]);
    assert.deepEqual(lojistas.map((l) => l.name), ["Lojista (Barraca de ramen)", "Lojista (Loja de armas)"], "um Lojista por lugar");
    const ramen = lojistas.find((l) => l.name.includes("ramen"))!;
    assert.ok(!texts(await knowsOf(id, ramen.id, "tantō")).some((t) => /tantō/.test(t)), "o Lojista da barraca não viu a compra");
    assert.ok(texts(await knowsOf(id, lojaArmas.id, "tantō")).some((t) => /tantō/.test(t)), "o da loja de armas viu");
    const [kiba] = await q<{ id: string }>(`SELECT id FROM characters WHERE campaign_id = $1 AND name = 'Kiba'`, [id]);
    const kibaKnows = await knowsOf(id, kiba.id, "");
    assert.deepEqual(kibaKnows.map((k) => [k.text, k.access]), [["O Hokage anunciou o Exame Chūnin para o fim do mês", "public"]], "NPC criado depois sabe só do público");
    ok("Lojista de duas lojas não divide o que sabe; fato público chega a quem entra depois");

    // 7. conversa particular com o Kiba: só ele e o jogador ficam sabendo (o Lojista ao lado não)
    await turn({ facts: [{ text: "Kiba confessou que tem medo do exame" }] }, [ids.Hugo, kiba.id]);
    assert.ok(texts(await knowsOf(id, kiba.id, "")).some((t) => /medo/.test(t)));
    assert.ok(!texts(await knowsOf(id, ramen.id, "")).some((t) => /medo/.test(t)), "conversa particular: o Lojista não ouviu");
    ok("conversa particular: fato só do jogador e do NPC");

    // 8. gerar novamente: fatos do turno e quem ficou sabendo de fato antigo somem
    const before = await q(`SELECT e.id, k.character_id FROM events e LEFT JOIN knowledge k ON k.event_id = e.id WHERE e.campaign_id = $1 ORDER BY 1, 2`, [id]);
    await takeSnapshot(id, "conto ao Kiba da caçada");
    await turn({ facts: [{ text: "Kiba prometeu treinar com Hugo amanhã" }], told: [{ fact: "Hugo e Genma caçaram um javali na horta", by: "Hugo", to: ["Kiba"] }] });
    assert.ok(texts(await knowsOf(id, kiba.id, "javali")).some((t) => /javali/.test(t)), "Kiba ouviu da caçada");
    await restoreSnapshot(id);
    assert.deepEqual(await q(`SELECT e.id, k.character_id FROM events e LEFT JOIN knowledge k ON k.event_id = e.id WHERE e.campaign_id = $1 ORDER BY 1, 2`, [id]), before);
    assert.ok(!texts(await knowsOf(id, kiba.id, "javali")).some((t) => /javali/.test(t)), "Kiba esqueceu (o turno não aconteceu)");
    ok("gerar novamente apaga os fatos do turno e o 'contou' sobre fato antigo");

    console.log(`\n${n} verificações ok`);
  } finally {
    await q(`DELETE FROM jobs WHERE campaign_id = $1`, [id]).catch(() => {});
    await q(`DELETE FROM api_logs WHERE campaign_id = $1`, [id]).catch(() => {});
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

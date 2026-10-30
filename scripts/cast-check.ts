/**
 * Verificação do elenco da cena: set_scene com present, NPC que fala volta à cena e o
 * "gerar novamente" desfaz. Campanha temporária, sem IA. Rodar: npx tsx scripts/cast-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { executeGmTool, findNamed, ToolContext } from "../src/lib/tools";
import { fallbackCast } from "../src/lib/engine";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import type { Campaign, Scene, TurnEvent } from "../src/lib/types";

async function main() {
  const people = [{ name: "Iruka Umino" }, { name: "Sasuke Uchiha" }, { name: "Itachi Uchiha" }, { name: "Mizuki" }];
  assert.deepEqual(findNamed(people, "Iruka-sensei").map((c) => c.name), ["Iruka Umino"]);
  assert.deepEqual(findNamed(people, "itachi uchiha").map((c) => c.name), ["Itachi Uchiha"], "nome exato vence a chave");
  assert.deepEqual(findNamed(people, "Kakashi"), []);

  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-elenco]', '{}') RETURNING id`);
  const id = c.id;
  try {
    const [scene] = await q<Scene>(
      `INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Academia') RETURNING *`,
      [id]
    );
    await q(
      `INSERT INTO characters (campaign_id, kind, name, active) VALUES
       ($1, 'player', 'Hugo', TRUE), ($1, 'npc', 'Iruka Umino', TRUE), ($1, 'npc', 'Mizuki', TRUE), ($1, 'npc', 'Kakashi Hatake', FALSE)`,
      [id]
    );
    const active = async () =>
      (await q<{ name: string }>(`SELECT name FROM characters WHERE campaign_id = $1 AND kind = 'npc' AND active ORDER BY name`, [id])).map((r) => r.name);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: { id, state: {}, ruleset: {} } as unknown as Campaign, scene, emit: (e) => events.push(e) };
    const chips = () => events.flatMap((e) => (e.type === "tool" ? [e.summary] : []));

    await takeSnapshot(id, "vou ao campo de treino");

    // troca de local sem present: avisa e não mexe
    let out = await executeGmTool("set_scene", { location: "Campo de treino" }, ctx);
    assert.match(out, /FALTOU present: Iruka Umino, Mizuki/);
    assert.equal(ctx.sceneChanged, true);
    assert.equal(ctx.castSet, undefined);
    assert.deepEqual(await active(), ["Iruka Umino", "Mizuki"]);

    // só present: Mizuki sai, Kakashi volta, o jogador e o desconhecido não quebram nada
    events.length = 0;
    out = await executeGmTool("set_scene", { present: ["Kakashi", "Iruka-sensei", "Hugo", "Guy"] }, ctx);
    assert.deepEqual(await active(), ["Iruka Umino", "Kakashi Hatake"]);
    assert.equal(ctx.castSet, true);
    assert.match(out, /NPCs em cena: Iruka Umino, Kakashi Hatake\./);
    assert.match(out, /Sem registro: Guy/);
    assert.deepEqual(chips(), ["Mizuki saiu de cena", "Kakashi Hatake entrou em cena"], "sem chip de cena repetido");
    assert.ok(events.some((e) => e.type === "state"));

    // cena nova com present vazio: todos saem
    await executeGmTool("set_scene", { newScene: true, location: "Casa", present: [] }, ctx);
    assert.deepEqual(await active(), []);

    // NPC fora de cena que fala na narração volta, sem IA (castSet pula o Jev)
    events.length = 0;
    await fallbackCast(id, ctx, "abro a porta", 'Batem na porta.\n\n**Mizuki:** "Posso entrar?"\n**Kakashi-sensei:** "Yo."', (e) => events.push(e));
    assert.deepEqual(await active(), ["Kakashi Hatake", "Mizuki"]);
    assert.deepEqual(chips(), ["Kakashi Hatake entrou em cena", "Mizuki entrou em cena"]);

    // ninguém calado em cena: não chama o Jev nem mexe
    events.length = 0;
    await fallbackCast(id, { ...ctx, castSet: false }, "oi", '**Mizuki:** "Oi."\n**Kakashi:** "Yo."', (e) => events.push(e));
    assert.equal(events.length, 0);

    // gerar novamente volta o elenco e a cena
    await restoreSnapshot(id);
    assert.deepEqual(await active(), ["Iruka Umino", "Mizuki"]);
    const scenes = await q<{ location: string }>(`SELECT location FROM scenes WHERE campaign_id = $1`, [id]);
    assert.deepEqual(scenes, [{ location: "Academia" }]);

    console.log("cast-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

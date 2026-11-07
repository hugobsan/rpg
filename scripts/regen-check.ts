/**
 * Verificação do "gerar novamente": cria uma campanha temporária, tira a foto,
 * mexe em tudo que um turno mexe, restaura e confere que voltou. Não chama IA.
 * Rodar: npx tsx scripts/regen-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { regenNotes, restoreSnapshot, snapshotOption, takeSnapshot } from "../src/lib/turnSnapshot";

async function main() {
  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, script) VALUES ('[teste-regen]', '{}', '{"arcs":[]}') RETURNING id`
  );
  const id = c.id;
  try {
    const [scene] = await q<{ id: string }>(
      `INSERT INTO scenes (campaign_id, seq, mode, location) VALUES ($1, 1, 'exploration', 'Academia') RETURNING id`,
      [id]
    );
    const [hero] = await q<{ id: string }>(
      `INSERT INTO characters (campaign_id, kind, name, sheet) VALUES ($1, 'player', 'Hugo', '{"hp":40,"xp":0}') RETURNING id`,
      [id]
    );
    await q(`INSERT INTO messages (campaign_id, scene_id, role, content) VALUES ($1, $2, 'gm', 'abertura')`, [id, scene.id]);
    await q(`INSERT INTO memories (campaign_id, content) VALUES ($1, 'memória antiga')`, [id]);

    // motivos dos "gerar novamente" somam na foto da mesma ação; ação nova zera
    await takeSnapshot(id, "ataco o boneco de treino", ["com o Hokage"]);
    await takeSnapshot(id, "ataco o boneco de treino", [...(await regenNotes(id)), "sem repetir missão"]);
    assert.deepEqual(await regenNotes(id), ["com o Hokage", "sem repetir missão"], "motivos somam");
    await takeSnapshot(id, "ataco o boneco de treino", [], 2);
    assert.deepEqual(await regenNotes(id), [], "ação nova zera");
    assert.equal(await snapshotOption(id), 2, "a opção escolhida fica na foto");

    // o que um turno faria
    await q(`INSERT INTO messages (campaign_id, scene_id, role, content) VALUES ($1, $2, 'player', 'ataco o boneco de treino'), ($1, $2, 'gm', 'resposta')`, [id, scene.id]);
    // trechos do histórico vetorial (um por narração): o do turno refeito some pela FK
    await q(`INSERT INTO history_chunks (campaign_id, message_id, content) SELECT campaign_id, id, content FROM messages WHERE campaign_id = $1 AND role = 'gm'`, [id]);
    await q(`UPDATE characters SET sheet = '{"hp":12,"xp":50}', active = FALSE WHERE id = $1`, [hero.id]);
    await q(`INSERT INTO characters (campaign_id, kind, name) VALUES ($1, 'npc', 'Mizuki')`, [id]);
    await q(`UPDATE scenes SET mode = 'battle', location = 'Floresta', is_current = FALSE WHERE id = $1`, [scene.id]);
    await q(`INSERT INTO scenes (campaign_id, seq, mode) VALUES ($1, 2, 'battle')`, [id]);
    await q(`INSERT INTO memories (campaign_id, content) VALUES ($1, 'memória nova do turno')`, [id]);
    await q(`UPDATE campaigns SET script = '{"arcs":[{"title":"novo"}]}' WHERE id = $1`, [id]);

    const input = await restoreSnapshot(id);

    assert.equal(input, "ataco o boneco de treino");
    const chars = await q<{ name: string; sheet: { hp: number; xp: number }; active: boolean }>(
      `SELECT name, sheet, active FROM characters WHERE campaign_id = $1`, [id]);
    assert.deepEqual(chars.map((x) => x.name), ["Hugo"], "NPC criado no turno deve sumir");
    assert.deepEqual(chars[0].sheet, { hp: 40, xp: 0 }, "ficha volta ao valor de antes");
    assert.equal(chars[0].active, true);
    const scenes = await q<{ mode: string; location: string; is_current: boolean }>(
      `SELECT mode, location, is_current FROM scenes WHERE campaign_id = $1`, [id]);
    assert.deepEqual(scenes, [{ mode: "exploration", location: "Academia", is_current: true }], "cena volta e a nova some");
    const msgs = await q<{ content: string }>(`SELECT content FROM messages WHERE campaign_id = $1 ORDER BY id`, [id]);
    assert.deepEqual(msgs, [{ content: "abertura" }], "mensagens do turno somem");
    const chunks = await q<{ content: string }>(`SELECT content FROM history_chunks WHERE campaign_id = $1`, [id]);
    assert.deepEqual(chunks.map((h) => h.content), ["abertura"], "trecho do histórico do turno some");
    const mems = await q<{ content: string }>(`SELECT content FROM memories WHERE campaign_id = $1`, [id]);
    assert.deepEqual(mems.map((m) => m.content), ["memória antiga"]);
    const [camp] = await q<{ script: unknown }>(`SELECT script FROM campaigns WHERE id = $1`, [id]);
    assert.deepEqual(camp.script, { arcs: [] }, "roteiro volta");

    console.log("ok: gerar novamente restaura ficha, NPCs, cena, mensagens, memórias, histórico e roteiro");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

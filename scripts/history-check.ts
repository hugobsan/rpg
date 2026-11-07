/**
 * Verificação do histórico vetorial (history_chunks / search_history): montagem dos trechos, gravação sem
 * embeddings, busca com fallback de texto, formato devolvido ao Mestre, limpeza no "gerar novamente" e ao apagar
 * a campanha. Sem IA nem rede (fetch desligado: embed() devolve null).
 * Rodar: npx tsx scripts/history-check.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, q } from "../src/lib/db";
import { excerpt, historyChunks, indexHistory, searchHistory } from "../src/lib/retrieval";
import { executeGmTool, ToolContext } from "../src/lib/tools";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import type { Campaign, Scene } from "../src/lib/types";

globalThis.fetch = (async () => {
  throw new Error("sem rede no check");
}) as typeof fetch;

const filler = Array.from({ length: 30 }, (_, i) => `O vento sopra pela rua número ${i}.`).join(" ");

async function main() {
  // montagem: turno = falas do jogador + narração; NPC = falas da sessão + resposta; fala sem resposta fica de fora
  const chunks = historyChunks(
    [
      { id: 1, role: "gm", content: "Abertura.", location: "Vila" },
      { id: 2, role: "player", content: "Ataco\n o boneco", location: "Vila" },
      { id: 3, role: "player", content: "e corro", location: "Vila" },
      { id: 4, role: "gm", content: "O boneco cai.", location: "Campo" },
      { id: 5, role: "player", content: "sem resposta ainda", location: "Campo" },
    ],
    [
      { id: 10, role: "npc", content: "Me encontre no portão.", session_id: "s1", npc: "Iruka" },
      { id: 11, role: "player", content: "oi", session_id: "s2", npc: "Naruto" },
      { id: 12, role: "player", content: "vou", session_id: "s1", npc: "Iruka" },
      { id: 13, role: "npc", content: "olá", session_id: "s2", npc: "Naruto" },
      { id: 14, role: "npc", content: "Ótimo.", session_id: "s1", npc: "Iruka" },
    ]
  );
  assert.deepEqual(
    chunks.map((c) => [c.message_id ?? c.npc_chat_id, c.npc, c.location, c.content]),
    [
      [1, null, "Vila", "Mestre: Abertura."],
      [4, null, "Campo", "Jogador: Ataco o boneco / e corro\nMestre: O boneco cai."],
      [10, "Iruka", null, "Iruka: Me encontre no portão."],
      [13, "Naruto", null, "Jogador: oi\nNaruto: olá"],
      [14, "Iruka", null, "Jogador: vou\nIruka: Ótimo."],
    ]
  );

  // corte curto em volta do que bate com a busca, mantendo a ação e quem responde
  const long = `Jogador: pergunto se ele é o Naruto\nMestre: ${filler} **Naruto:** "Sou eu sim, tô ligado!" ${filler}`;
  const cut = excerpt(long, "o que o Naruto respondeu quando perguntei");
  assert.ok(cut.length < 800 && cut.length < long.length, `corte curto: ${cut.length}`);
  assert.ok(cut.startsWith("Jogador: pergunto se ele é o Naruto\nMestre: …"), cut);
  assert.ok(cut.includes("Sou eu sim") && cut.endsWith("…"), cut);
  assert.equal(excerpt("Mestre: curto.", "x"), "Mestre: curto.");

  const [c] = await q<{ id: string }>(
    `INSERT INTO campaigns (name, ruleset, state) VALUES ('[teste-historico]', '{}', '{"clock":{"minutes":2280}}') RETURNING id`
  );
  const id = c.id;
  try {
    const [scene] = await q<Scene>(
      `INSERT INTO scenes (campaign_id, seq, location) VALUES ($1, 1, 'Quiosque de ramen, Konoha') RETURNING *`,
      [id]
    );
    const [naruto] = await q<{ id: string }>(
      `INSERT INTO characters (campaign_id, kind, name) VALUES ($1, 'npc', 'Naruto Uzumaki') RETURNING id`,
      [id]
    );
    const msg = (role: string, content: string) =>
      q(`INSERT INTO messages (campaign_id, scene_id, role, content) VALUES ($1, $2, $3, $4)`, [id, scene.id, role, content]);
    await msg("player", "Como um ramen e pergunto ao garoto se ele é o Naruto");
    await msg("gm", `${filler} **Naruto Uzumaki:** "Sou eu sim, tô ligado! Vou ser Hokage!" ${filler}`);
    await msg("player", "Treino arremesso de kunai");
    await msg("gm", "A kunai acerta o alvo de madeira.");
    await q(
      `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content)
       VALUES ($1, $2, $3, 'player', 'quer treinar comigo?'), ($1, $2, $3, 'npc', 'Bora! Mas eu ganho.')`,
      [id, naruto.id, randomUUID()]
    );

    // gravação sem embeddings: fica o texto, com hora e local do turno
    assert.equal(await indexHistory(id), 3);
    assert.equal(await indexHistory(id), 0, "não grava de novo");
    const rows = await q<{ npc: string | null; clock: number; location: string; content: string; embedding: string | null }>(
      `SELECT npc, clock, location, content, embedding::text FROM history_chunks WHERE campaign_id = $1 ORDER BY id`,
      [id]
    );
    assert.deepEqual(
      rows.map((r) => [r.npc, r.clock, r.location, r.embedding]),
      [
        [null, 2280, "Quiosque de ramen, Konoha", null],
        [null, 2280, "Quiosque de ramen, Konoha", null],
        ["Naruto Uzumaki", 2280, "Quiosque de ramen, Konoha", null],
      ]
    );
    assert.equal(rows[2].content, "Jogador: quer treinar comigo?\nNaruto Uzumaki: Bora! Mas eu ganho.");

    // busca por texto (sem embeddings): qualquer termo, por relevância; npc filtra
    const hits = await searchHistory(id, "o que o Naruto respondeu quando perguntei se era ele");
    assert.ok(hits[0].content.startsWith("Jogador: Como um ramen"), "o turno da pergunta vem primeiro");
    assert.deepEqual((await searchHistory(id, "kunai alvo")).map((h) => h.content), ["Jogador: Treino arremesso de kunai\nMestre: A kunai acerta o alvo de madeira."]);
    assert.equal((await searchHistory(id, "treinar", { npc: "Naruto-kun" })).length, 1);

    // o que o Mestre recebe da ferramenta
    const ctx = { campaign: { id, state: {}, ruleset: {} } as unknown as Campaign, scene, emit: () => {} } as ToolContext;
    const out = await executeGmTool("search_history", { query: "o que o Naruto respondeu quando perguntei" }, ctx);
    assert.ok(out.startsWith("Trechos do chat: é o que aconteceu naquele momento; se discordarem da ficha ou dos fatos atuais, valem a ficha e os fatos."), out);
    assert.ok(out.includes("[Dia 2 · 14:00, Quiosque de ramen, Konoha]\nJogador: Como um ramen"), out);
    assert.ok(out.includes("Sou eu sim") && out.length < 2500, `curto: ${out.length}`);
    const npcOut = await executeGmTool("search_history", { query: "treinar", npc: "Naruto" }, ctx);
    assert.ok(npcOut.includes("conversa particular com Naruto Uzumaki"), npcOut);
    assert.equal(await executeGmTool("search_history", { query: "dragão voador" }, ctx), "Nada encontrado no histórico.");

    // gerar novamente: o trecho do turno refeito e a conversa com NPC depois da foto somem junto com as mensagens
    await takeSnapshot(id, "falo com o Naruto");
    await msg("player", "falo com o Naruto");
    await msg("gm", "Naruto ri.");
    await q(
      `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content) VALUES ($1, $2, gen_random_uuid(), 'npc', 'Ei!')`,
      [id, naruto.id]
    );
    assert.equal(await indexHistory(id), 2);
    await restoreSnapshot(id);
    assert.equal((await q(`SELECT id FROM history_chunks WHERE campaign_id = $1`, [id])).length, 3, "trechos do turno refeito somem");
    assert.equal(await indexHistory(id), 0);

    console.log("history-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    assert.equal((await q(`SELECT id FROM history_chunks WHERE campaign_id = $1`, [id])).length, 0, "campanha apagada limpa os trechos");
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Verificação da mensagem particular de NPC (npc_message): caixa de entrada, leitura e
 * "gerar novamente". Campanha temporária, sem IA. Rodar: npx tsx scripts/npc-message-check.ts
 */
import assert from "node:assert/strict";
import { pool, q } from "../src/lib/db";
import { executeGmTool, ToolContext } from "../src/lib/tools";
import { listInbox, openPending } from "../src/lib/npc";
import { restoreSnapshot, takeSnapshot } from "../src/lib/turnSnapshot";
import type { Campaign, Scene, TurnEvent } from "../src/lib/types";

async function main() {
  const [c] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-npc-msg]', '{}') RETURNING id`);
  const id = c.id;
  try {
    const [scene] = await q<Scene>(`INSERT INTO scenes (campaign_id, seq) VALUES ($1, 1) RETURNING *`, [id]);
    const [iruka] = await q<{ id: string }>(
      `INSERT INTO characters (campaign_id, kind, name, active) VALUES ($1, 'npc', 'Iruka', FALSE) RETURNING id`,
      [id]
    );
    await q(`INSERT INTO characters (campaign_id, kind, name) VALUES ($1, 'player', 'Hugo')`, [id]);
    const events: TurnEvent[] = [];
    const ctx: ToolContext = { campaign: { id, state: {}, ruleset: {} } as unknown as Campaign, scene, emit: (e) => events.push(e) };

    await takeSnapshot(id, "durmo");

    const message = "Um pássaro pousa na janela com um bilhete: \"Me encontre no portão ao amanhecer. — Iruka\"";
    const out = await executeGmTool("npc_message", { npc: "iruka", message, intent: "avisar que Mizuki roubou o pergaminho" }, ctx);
    assert.match(out, /entregue/);
    assert.deepEqual(events.find((e) => e.type === "npc_message"), { type: "npc_message", npcId: iruka.id, name: "Iruka", preview: message.slice(0, 140) });
    assert.ok(events.some((e) => e.type === "tool" && e.summary.startsWith("✉️")));
    const [row] = await q<{ role: string; unread: boolean; intent: string }>(`SELECT role, unread, intent FROM npc_chats WHERE campaign_id = $1`, [id]);
    assert.deepEqual(row, { role: "npc", unread: true, intent: "avisar que Mizuki roubou o pergaminho" });
    const [mem] = await q<{ content: string }>(`SELECT content FROM memories WHERE campaign_id = $1`, [id]);
    assert.ok(mem.content.includes("Me encontre no portão") && !mem.content.includes("pergaminho"), "memória sem o motivo oculto");

    // uma mensagem não lida por NPC
    assert.match(await executeGmTool("npc_message", { npc: "Iruka", message: "De novo", intent: "x" }, ctx), /ainda não leu/);
    assert.match(await executeGmTool("npc_message", { npc: "Hugo", message: "x", intent: "x" }, ctx), /não é NPC/);

    const inbox = await listInbox(id);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].npcId, iruka.id);
    assert.equal(inbox[0].unread, 1);
    assert.equal(inbox[0].preview, message.slice(0, 140));
    assert.ok(inbox[0].at);

    const open = await openPending(id, iruka.id);
    assert.equal(open.sessionId, inbox[0].sessionId);
    assert.deepEqual(open.messages.map((m) => [m.role, m.content]), [["npc", message]]);
    assert.deepEqual(await listInbox(id), [], "abrir marca como lida");
    assert.equal((await openPending(id, iruka.id)).sessionId, null);

    // gerar novamente desfaz a mensagem e a memória
    await restoreSnapshot(id);
    assert.deepEqual(await q(`SELECT id FROM npc_chats WHERE campaign_id = $1`, [id]), []);
    assert.deepEqual(await q(`SELECT id FROM memories WHERE campaign_id = $1`, [id]), []);

    console.log("npc-message-check: ok");
  } finally {
    await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

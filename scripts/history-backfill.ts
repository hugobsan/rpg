/**
 * Vetoriza o histórico que já existe (turnos e conversas com NPC) em history_chunks, em todas as campanhas. Os turnos
 * novos entram sozinhos depois da narração; isto é para o que veio antes. Só escreve em history_chunks e só chama o
 * modelo de embeddings. Idempotente: pula o que já está lá.
 * Rodar: npx tsx scripts/history-backfill.ts
 */
import { pool, q } from "../src/lib/db";
import { indexHistory } from "../src/lib/retrieval";
import { toMinutes } from "../src/lib/clock";

async function main() {
  try {
    for (const c of await q<{ id: string; name: string }>(`SELECT id, name FROM campaigns ORDER BY created_at`)) {
      const added = await indexHistory(c.id, false);
      // ponytail: a hora do jogo dos turnos antigos não foi gravada; estima pelo último "Dia N · HH:MM" que apareceu
      // numa chamada da campanha (api_logs: resultado de set_time/advance_time, relógio do Jev) até a mensagem.
      // Sem log com relógio antes (relógio ainda não definido, logs apagados), fica sem hora.
      const logs = await q<{ at: Date; t: string }>(
        `SELECT created_at AS at, request::text || ' ' || COALESCE(response::text, '') AS t FROM api_logs
         WHERE campaign_id = $1 AND request::text || COALESCE(response::text, '') ~ 'Dia [0-9]+ · [0-9]{2}:[0-9]{2}'
         ORDER BY created_at`,
        [c.id]
      );
      const undated = await q<{ id: number; at: Date }>(
        `SELECT h.id, COALESCE(m.created_at, n.created_at) AS at FROM history_chunks h
         LEFT JOIN messages m ON m.id = h.message_id LEFT JOIN npc_chats n ON n.id = h.npc_chat_id
         WHERE h.campaign_id = $1 AND h.clock IS NULL`,
        [c.id]
      );
      let dated = 0;
      for (const h of undated) {
        const log = logs.filter((l) => l.at <= h.at).pop();
        const m = log && [...log.t.matchAll(/Dia (\d+) · (\d{2}):(\d{2})/g)].pop();
        if (!m) continue;
        await q(`UPDATE history_chunks SET clock = $1 WHERE id = $2`, [toMinutes(+m[1], +m[2], +m[3]), h.id]);
        dated++;
      }
      const [s] = await q<{ total: number; vec: number; clock: number }>(
        `SELECT count(*)::int AS total, count(embedding)::int AS vec, count(clock)::int AS clock FROM history_chunks WHERE campaign_id = $1`,
        [c.id]
      );
      console.log(`${c.name}: ${added} trechos novos, ${dated} com hora estimada (${s.total} no total, ${s.vec} com embedding, ${s.clock} com hora)`);
    }
  } finally {
    await pool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

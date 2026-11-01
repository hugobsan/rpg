import { db, q } from "./db";

/**
 * Foto do estado da campanha antes do último turno, para "gerar novamente" a
 * resposta do Mestre sem duplicar o que as ferramentas mudaram (dano, XP, itens,
 * NPCs criados, cena, memórias). Só o último turno pode ser refeito.
 *
 * ponytail: volta o estado inteiro da campanha; uma conversa particular com NPC
 * feita depois do turno também é desfeita (falas, memórias novas e mudanças nas fichas).
 * Diretrizes da conversa fora do jogo, regras da mesa e tema ficam (não são estado da história).
 */
// fichas no formato gravado (abilities = { ref, progress }): salvar e restaurar copiam a linha crua, sem hidratar
interface Snapshot {
  characters: Record<string, unknown>[];
  scenes: Record<string, unknown>[];
  campaign: { script: unknown; state: unknown };
  maxMessageId: number;
  maxMemoryId: number;
  maxNpcChatId?: number; // ausente em fotos antigas: não apaga conversa nenhuma
  openMessageIds: number[]; // mensagens não compactadas (a compactação pós-turno as marca)
}

export async function takeSnapshot(campaignId: string, playerInput: string): Promise<void> {
  const [characters, scenes, [campaign], [ids], open] = await Promise.all([
    q(`SELECT * FROM characters WHERE campaign_id = $1`, [campaignId]),
    q(`SELECT * FROM scenes WHERE campaign_id = $1`, [campaignId]),
    q<{ script: unknown; state: unknown }>(`SELECT script, state FROM campaigns WHERE id = $1`, [campaignId]),
    q<{ msg: string | null; mem: string | null; npc: string | null }>(
      `SELECT (SELECT MAX(id) FROM messages WHERE campaign_id = $1) AS msg,
              (SELECT MAX(id) FROM memories WHERE campaign_id = $1) AS mem,
              (SELECT MAX(id) FROM npc_chats WHERE campaign_id = $1) AS npc`,
      [campaignId]
    ),
    q<{ id: string }>(`SELECT id FROM messages WHERE campaign_id = $1 AND NOT compacted`, [campaignId]),
  ]);
  const snap: Snapshot = {
    characters,
    scenes,
    campaign,
    maxMessageId: Number(ids.msg ?? 0),
    maxMemoryId: Number(ids.mem ?? 0),
    maxNpcChatId: Number(ids.npc ?? 0),
    openMessageIds: open.map((m) => Number(m.id)),
  };
  await q(
    `INSERT INTO turn_snapshots (campaign_id, player_input, data) VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id) DO UPDATE SET player_input = EXCLUDED.player_input, data = EXCLUDED.data, created_at = now()`,
    [campaignId, playerInput, JSON.stringify(snap)]
  );
}

/**
 * Volta a campanha ao estado anterior ao último turno e devolve a ação do jogador daquele turno.
 * keepAction ("parar" o Mestre): a ação do jogador (1ª mensagem depois da foto) fica, como num turno que falhou;
 * "gerar novamente" e editar seguem valendo para ela, inclusive depois de recarregar a página.
 */
export async function restoreSnapshot(campaignId: string, keepAction = false): Promise<string> {
  const [row] = await q<{ player_input: string; data: Snapshot }>(
    `SELECT player_input, data FROM turn_snapshots WHERE campaign_id = $1`,
    [campaignId]
  );
  if (!row) throw new Error("Não há turno para gerar novamente.");
  const s = row.data;
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    // linhas criadas no turno somem; as que já existiam voltam ao valor da foto
    for (const [table, rows] of [["characters", s.characters], ["scenes", s.scenes]] as const) {
      await client.query(
        `DELETE FROM ${table} WHERE campaign_id = $1 AND NOT (id = ANY($2::uuid[]))`,
        [campaignId, rows.map((r) => r.id)]
      );
      for (const r of rows) {
        const cols = Object.keys(r).filter((c) => c !== "id").map((c) => `"${c}"`);
        await client.query(
          `UPDATE ${table} SET (${cols.join(",")}) = (SELECT ${cols.join(",")} FROM jsonb_populate_record(NULL::${table}, $1))
           WHERE id = $2`,
          [JSON.stringify(r), r.id]
        );
      }
    }
    await client.query(
      `UPDATE campaigns SET script = $1,
         state = ($2::jsonb - 'table' - 'theme') || jsonb_strip_nulls(jsonb_build_object('table', state->'table', 'theme', state->'theme'))
       WHERE id = $3`,
      [
        JSON.stringify(s.campaign.script),
        JSON.stringify(s.campaign.state),
        campaignId,
      ]
    );
    await client.query(
      `DELETE FROM messages WHERE campaign_id = $1 AND id > $2
         AND NOT ($3 AND id = COALESCE((SELECT MIN(id) FROM messages WHERE campaign_id = $1 AND id > $2 AND role = 'player'), 0))`,
      [campaignId, s.maxMessageId, keepAction]
    );
    await client.query(`DELETE FROM memories WHERE campaign_id = $1 AND id > $2 AND kind <> 'directive'`, [campaignId, s.maxMemoryId]);
    // mensagens de NPC (npc_message) e falas de conversa particular depois da foto
    await client.query(`DELETE FROM npc_chats WHERE campaign_id = $1 AND id > $2`, [campaignId, s.maxNpcChatId ?? null]);
    await client.query(`UPDATE messages SET compacted = FALSE WHERE id = ANY($1::bigint[])`, [s.openMessageIds]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return row.player_input;
}

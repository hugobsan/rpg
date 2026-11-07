import { db, q } from "./db";

/**
 * Foto do estado da campanha antes do último turno, para "gerar novamente" a
 * resposta do Mestre sem duplicar o que as ferramentas mudaram (dano, XP, itens,
 * NPCs criados, cena, memórias). Só o último turno pode ser refeito.
 *
 * ponytail: volta o estado inteiro da campanha; uma conversa particular com NPC
 * feita depois do turno também é desfeita (falas, fatos novos e mudanças nas fichas), e a missão aceita ou recusada
 * no painel depois dele volta a oferecida (ou some, se o turno a criou).
 * Diretrizes da conversa fora do jogo, regras da mesa e tema ficam (não são estado da história).
 */
const STORY = ["arcs", "beats", "clocks", "hooks"] as const;

// fichas no formato gravado (abilities = { ref, progress }): salvar e restaurar copiam a linha crua, sem hidratar
interface Snapshot {
  characters: Record<string, unknown>[];
  scenes: Record<string, unknown>[];
  campaign: { state: unknown };
  story?: { arcs: unknown[]; beats: unknown[]; clocks: unknown[]; hooks: unknown[] }; // ausente em fotos antigas: não mexe
  maxMessageId: number;
  maxMemoryId: number;
  maxNpcChatId?: number; // ausente em fotos antigas: não apaga conversa nenhuma
  maxEventId?: number; // fatos (events) e quem sabe (knowledge) depois da foto somem; ausente em fotos antigas: não mexe
  maxKnowledgeId?: number;
  regenNotes?: string[]; // motivos dos "gerar novamente" desta ação, em ordem (somam a cada vez; ação nova zera)
  option?: number; // a ação foi a opção N da narração anterior: o "gerar novamente" resolve a mesma opção tipada
}

/** Motivos dos "gerar novamente" já pedidos para a ação da foto atual. */
export async function regenNotes(campaignId: string): Promise<string[]> {
  const [row] = await q<{ notes: unknown }>(`SELECT data->'regenNotes' AS notes FROM turn_snapshots WHERE campaign_id = $1`, [campaignId]);
  return Array.isArray(row?.notes) ? row.notes.map(String) : [];
}

/** Índice da opção escolhida na ação da foto atual (undefined = texto livre). */
export async function snapshotOption(campaignId: string): Promise<number | undefined> {
  const [row] = await q<{ option: unknown }>(`SELECT data->'option' AS option FROM turn_snapshots WHERE campaign_id = $1`, [campaignId]);
  return typeof row?.option === "number" ? row.option : undefined;
}

export async function takeSnapshot(campaignId: string, playerInput: string, notes: string[] = [], option?: number): Promise<void> {
  const [characters, scenes, [campaign], [ids], ...story] = await Promise.all([
    q(`SELECT * FROM characters WHERE campaign_id = $1`, [campaignId]),
    q(`SELECT * FROM scenes WHERE campaign_id = $1`, [campaignId]),
    q<{ state: unknown }>(`SELECT state FROM campaigns WHERE id = $1`, [campaignId]),
    q<{ msg: string | null; mem: string | null; npc: string | null; ev: string | null; kn: string | null }>(
      `SELECT (SELECT MAX(id) FROM messages WHERE campaign_id = $1) AS msg,
              (SELECT MAX(id) FROM memories WHERE campaign_id = $1) AS mem,
              (SELECT MAX(id) FROM npc_chats WHERE campaign_id = $1) AS npc,
              (SELECT MAX(id) FROM events) AS ev,
              (SELECT MAX(id) FROM knowledge) AS kn`,
      [campaignId]
    ),
    ...STORY.map((t) => q(`SELECT * FROM ${t} WHERE campaign_id = $1`, [campaignId])),
  ]);
  const snap: Snapshot = {
    characters,
    scenes,
    campaign,
    story: Object.fromEntries(STORY.map((t, i) => [t, story[i]])) as Snapshot["story"],
    maxMessageId: Number(ids.msg ?? 0),
    maxMemoryId: Number(ids.mem ?? 0),
    maxNpcChatId: Number(ids.npc ?? 0),
    maxEventId: Number(ids.ev ?? 0),
    maxKnowledgeId: Number(ids.kn ?? 0),
    ...(notes.length && { regenNotes: notes }),
    ...(option !== undefined && { option }),
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
      `UPDATE campaigns SET
         state = ($1::jsonb - 'table' - 'theme') || jsonb_strip_nulls(jsonb_build_object('table', state->'table', 'theme', state->'theme'))
       WHERE id = $2`,
      [JSON.stringify(s.campaign.state), campaignId]
    );
    // história (arcos, beats, relógios, ganchos): apaga e regrava como na foto, na ordem das FKs
    if (s.story) {
      for (const t of [...STORY].reverse()) await client.query(`DELETE FROM ${t} WHERE campaign_id = $1`, [campaignId]);
      for (const t of STORY)
        await client.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(NULL::${t}, $1)`, [JSON.stringify(s.story[t])]);
    }
    await client.query(
      `DELETE FROM messages WHERE campaign_id = $1 AND id > $2
         AND NOT ($3 AND id = COALESCE((SELECT MIN(id) FROM messages WHERE campaign_id = $1 AND id > $2 AND role = 'player'), 0))`,
      [campaignId, s.maxMessageId, keepAction]
    );
    await client.query(`DELETE FROM memories WHERE campaign_id = $1 AND id > $2 AND kind <> 'directive'`, [campaignId, s.maxMemoryId]);
    // fatos do turno (e da conversa particular depois dele) e quem ficou sabendo de fato antigo
    await client.query(`DELETE FROM events WHERE campaign_id = $1 AND id > $2`, [campaignId, s.maxEventId ?? null]);
    await client.query(`DELETE FROM knowledge k USING events e WHERE e.id = k.event_id AND e.campaign_id = $1 AND k.id > $2`, [campaignId, s.maxKnowledgeId ?? null]);
    // mensagens de NPC (npc_message) e falas de conversa particular depois da foto
    await client.query(`DELETE FROM npc_chats WHERE campaign_id = $1 AND id > $2`, [campaignId, s.maxNpcChatId ?? null]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return row.player_input;
}

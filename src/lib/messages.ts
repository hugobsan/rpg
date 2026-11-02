import { q } from "@/lib/db";

export const MESSAGE_PAGE = 30; // mensagens por lote no chat
export const MESSAGE_PAGE_MAX = 100; // teto do que o cliente pode pedir

/** Até `limit` mensagens do chat (jogador/Mestre/conversa particular encerrada) anteriores a `before` (ou as mais recentes), em ordem cronológica. */
export async function messagePage(campaignId: string, before?: number, limit = MESSAGE_PAGE) {
  const rows = await q<{ id: number; role: string; speaker: string | null; content: string; meta: unknown; created_at: string }>(
    `SELECT id, role, speaker, content, meta, created_at::text FROM messages
     WHERE campaign_id = $1 AND role IN ('player','gm','talk') AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT $3`,
    [campaignId, before ?? null, limit + 1] // +1 para saber se há mais
  );
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

import { hasVector, q } from "./db";
import { embed, toVectorLiteral } from "./embeddings";

export interface MemoryHit {
  id: number;
  kind: string;
  subject: string | null;
  content: string;
  importance: number;
  created_at: string;
}

export interface ChunkHit {
  book_id: string;
  title: string;
  page: number;
  content: string;
}

/** Grava memória com embedding (quando disponível). */
export async function addMemory(
  campaignId: string,
  kind: string,
  content: string,
  subject?: string | null,
  importance = 3
): Promise<number> {
  const rows = await q<{ id: number }>(
    `INSERT INTO memories (campaign_id, kind, subject, content, importance)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [campaignId, kind, subject || null, content, importance]
  );
  const id = rows[0].id;
  if (await hasVector()) {
    const vecs = await embed([content]);
    if (vecs?.[0])
      await q(`UPDATE memories SET embedding = $1 WHERE id = $2`, [
        toVectorLiteral(vecs[0]),
        id,
      ]).catch(() => {});
  }
  return id;
}

/**
 * Busca memórias: vetorial (pgvector, cosseno) quando há embeddings;
 * fallback para full-text search + ILIKE do Postgres.
 */
export async function searchMemories(
  campaignId: string,
  query: string,
  opts: { kind?: string; subject?: string; limit?: number } = {}
): Promise<MemoryHit[]> {
  const limit = opts.limit ?? 6;
  // diretrizes do jogador entram sempre por activeDirectives, não pela busca
  const filters: string[] = ["campaign_id = $1", "kind <> 'directive'"];
  const params: unknown[] = [campaignId];
  if (opts.kind) {
    params.push(opts.kind);
    filters.push(`kind = $${params.length}`);
  }
  if (opts.subject) {
    params.push(opts.subject);
    filters.push(`subject = $${params.length}`);
  }
  const where = filters.join(" AND ");

  if (await hasVector()) {
    const vecs = await embed([query]);
    if (vecs?.[0]) {
      params.push(toVectorLiteral(vecs[0]), limit);
      const rows = await q<MemoryHit>(
        `SELECT id, kind, subject, content, importance, created_at::text
         FROM memories WHERE ${where} AND embedding IS NOT NULL
         ORDER BY embedding <=> $${params.length - 1} LIMIT $${params.length}`,
        params
      );
      if (rows.length) return rows;
      params.splice(-2); // sem embeddings gravados ainda: cai para FTS
    }
  }
  params.push(query, limit);
  return q<MemoryHit>(
    `SELECT id, kind, subject, content, importance, created_at::text
     FROM memories
     WHERE ${where} AND (
       to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $${params.length - 1})
       OR content ILIKE '%' || $${params.length - 1} || '%'
     )
     ORDER BY importance DESC, id DESC LIMIT $${params.length}`,
    params
  );
}

/** Memórias recentes/importantes independentes de query (contexto base do turno). */
export async function recentMemories(
  campaignId: string,
  limit = 8
): Promise<MemoryHit[]> {
  return q<MemoryHit>(
    `SELECT id, kind, subject, content, importance, created_at::text
     FROM memories WHERE campaign_id = $1 AND kind <> 'directive'
     ORDER BY importance DESC, id DESC LIMIT $2`,
    [campaignId, limit]
  );
}

/**
 * Diretrizes do jogador (conversa fora do jogo) que valem agora: memórias kind 'directive',
 * subject = escopo. "proxima_cena" vale na cena em que foi dada e na seguinte (sai quando
 * set_scene cria a 2ª cena depois dela). Derivado das cenas, então o "gerar novamente" acompanha.
 */
export async function activeDirectives(campaignId: string): Promise<{ id: number; subject: string; content: string }[]> {
  return q(
    `SELECT id, subject, content FROM memories m
     WHERE campaign_id = $1 AND kind = 'directive' AND (subject = 'permanente' OR
       (SELECT count(*) FROM scenes s WHERE s.campaign_id = m.campaign_id AND s.created_at > m.created_at) < 2)
     ORDER BY id`,
    [campaignId]
  );
}

/** Busca chunks de livros (vetorial ou FTS). */
export async function searchBookChunks(
  campaignId: string,
  query: string,
  limit = 5
): Promise<ChunkHit[]> {
  if (await hasVector()) {
    const vecs = await embed([query]);
    if (vecs?.[0]) {
      const rows = await q<ChunkHit>(
        `SELECT c.book_id, b.title, c.page, c.content
         FROM book_chunks c JOIN books b ON b.id = c.book_id
         WHERE b.campaign_id = $1 AND c.embedding IS NOT NULL
         ORDER BY c.embedding <=> $2 LIMIT $3`,
        [campaignId, toVectorLiteral(vecs[0]), limit]
      );
      if (rows.length) return rows;
    }
  }
  return q<ChunkHit>(
    `SELECT c.book_id, b.title, c.page, c.content
     FROM book_chunks c JOIN books b ON b.id = c.book_id
     WHERE b.campaign_id = $1 AND (
       to_tsvector('simple', c.content) @@ websearch_to_tsquery('simple', $2)
       OR c.content ILIKE '%' || $2 || '%'
     )
     LIMIT $3`,
    [campaignId, query, limit]
  );
}

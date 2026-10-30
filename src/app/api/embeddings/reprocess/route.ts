import { NextResponse } from "next/server";
import { db, hasVector } from "@/lib/db";
import { embed, getEmbeddingConfig, toVectorLiteral } from "@/lib/embeddings";
import { getSource } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

const TABLES = ["memories", "book_chunks", "history_chunks"] as const;
const BATCH = { memories: 64, book_chunks: 64, history_chunks: 16 }; // trecho do chat é um turno inteiro

/**
 * Regera os embeddings de memories, book_chunks e history_chunks com o modelo salvo.
 * Tudo numa transação: a busca só vê vetores antigos ou novos, nunca misturados.
 */
export async function POST() {
  const fail = (error: string, status = 400) =>
    NextResponse.json({ error }, { status });
  if (!(await hasVector())) return fail("pgvector indisponível neste banco.");
  const cfg = await getEmbeddingConfig();
  if (!cfg.enabled)
    return fail("Embeddings desabilitados: habilite e salve as configurações antes.");
  const srcError = await getSource(cfg.source).then(() => "", (e: Error) => e.message);
  if (srcError) return fail(srcError);

  const client = await (await db()).connect();
  const n = { memories: 0, book_chunks: 0, history_chunks: 0 }; // reprocessados
  const last = { memories: "0", book_chunks: "0", history_chunks: "0" }; // último id reprocessado
  try {
    await client.query("BEGIN");
    try {
      for (const t of TABLES) {
        for (;;) {
          const { rows } = await client.query(
            `SELECT id, content FROM ${t} WHERE id > $1 ORDER BY id LIMIT ${BATCH[t]}`,
            [last[t]]
          );
          if (!rows.length) break;
          const vecs = await embed(rows.map((r) => r.content));
          if (!vecs || Array.from(vecs).some((v) => !v))
            throw new Error("falha ao gerar embeddings na fonte configurada");
          await client.query(
            `UPDATE ${t} SET embedding = v.e::vector
             FROM unnest($1::bigint[], $2::text[]) AS v(id, e) WHERE ${t}.id = v.id`,
            [rows.map((r) => r.id), vecs.map((v) => toVectorLiteral(v))]
          );
          last[t] = rows[rows.length - 1].id;
          n[t] += rows.length;
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      const error = e instanceof Error ? e.message : "erro";
      try {
        // zera o que ficou sem reprocessar (vetor antigo pode ter outra dimensão): a busca cai no full-text
        for (const t of TABLES)
          await client.query(`UPDATE ${t} SET embedding = NULL WHERE id > $1`, [last[t]]);
        await client.query("COMMIT");
      } catch {
        // o próprio banco falhou: desfaz tudo e zera tudo
        await client.query("ROLLBACK");
        for (const t of TABLES) await client.query(`UPDATE ${t} SET embedding = NULL`);
        n.memories = n.book_chunks = n.history_chunks = 0;
      }
      return NextResponse.json({ error, ...n }, { status: 502 });
    }
    return NextResponse.json(n);
  } finally {
    client.release();
  }
}

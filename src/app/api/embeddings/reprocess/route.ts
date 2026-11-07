import { NextResponse } from "next/server";
import { getAdvanced } from "@/lib/advanced";
import { chunkPage } from "@/lib/books";
import { db, hasVector } from "@/lib/db";
import { embed, getEmbeddingConfig, toVectorLiteral } from "@/lib/embeddings";
import { getSource } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

const TABLES = ["events", "book_chunks", "history_chunks"] as const;

/**
 * Regera os embeddings de events (fatos), book_chunks e history_chunks com o modelo salvo, e antes refaz o chunking dos
 * livros a partir de book_pages com o chunk size/overlap das Configurações avançadas (mesmos valores = mesmos chunks).
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
  const adv = await getAdvanced();
  const BATCH = { events: adv.embeddings.batch, book_chunks: adv.embeddings.batch, history_chunks: adv.history.batch }; // trecho do chat é um turno inteiro
  let dims = 0; // dimensão dos vetores que o modelo devolveu

  const client = await (await db()).connect();
  const n = { events: 0, book_chunks: 0, history_chunks: 0 }; // reprocessados
  const last = { events: "0", book_chunks: "0", history_chunks: "0" }; // último id reprocessado
  try {
    await client.query("BEGIN");
    try {
      const { rows: pages } = await client.query(`SELECT book_id, page, content FROM book_pages ORDER BY book_id, page`);
      const chunks = pages.flatMap((p) =>
        chunkPage(p.content, adv.books.chunkChars, adv.books.overlapChars).map((content, i) => [p.book_id, p.page, i, content])
      );
      await client.query(`DELETE FROM book_chunks`);
      await client.query(
        `INSERT INTO book_chunks (book_id, page, chunk_index, content)
         SELECT * FROM unnest($1::uuid[], $2::int[], $3::int[], $4::text[])`,
        [0, 1, 2, 3].map((k) => chunks.map((c) => c[k]))
      );
      for (const t of TABLES) {
        for (;;) {
          const { rows } = await client.query(
            `SELECT id, ${t === "events" ? "text" : "content"} AS content FROM ${t} WHERE id > $1 ORDER BY id LIMIT ${BATCH[t]}`,
            [last[t]]
          );
          if (!rows.length) break;
          const vecs = await embed(rows.map((r) => r.content));
          if (!vecs || Array.from(vecs).some((v) => !v))
            throw new Error("falha ao gerar embeddings na fonte configurada");
          dims ||= vecs[0].length;
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
        n.events = n.book_chunks = n.history_chunks = 0;
      }
      return NextResponse.json({ error, ...n }, { status: 502 });
    }
    const want = adv.embeddings.dimensions;
    const warning = want && dims && dims !== want ? `O modelo ignorou dimensions=${want} e devolveu ${dims} dimensões.` : undefined;
    return NextResponse.json({ ...n, dims, warning });
  } finally {
    client.release();
  }
}

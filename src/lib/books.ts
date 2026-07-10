import { hasVector, q } from "./db";
import { embed, toVectorLiteral } from "./embeddings";

const CHUNK_CHARS = 2400; // ~700 tokens por chunk
const EMBED_BATCH = 32;

/** Extrai texto paginado de PDF/TXT/MD. */
export async function extractPages(
  filename: string,
  buf: Buffer
): Promise<string[]> {
  if (filename.toLowerCase().endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t) => t.trim());
  }
  // texto plano: pagina a cada ~6000 chars respeitando parágrafos
  const raw = buf.toString("utf-8");
  const paragraphs = raw.split(/\n\s*\n/);
  const pages: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (cur.length + p.length > 6000 && cur) {
      pages.push(cur.trim());
      cur = "";
    }
    cur += p + "\n\n";
  }
  if (cur.trim()) pages.push(cur.trim());
  return pages;
}

function chunkPage(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const cut = text.lastIndexOf(". ", end);
      if (cut > start + CHUNK_CHARS / 2) end = cut + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

/** Indexa um livro: páginas + chunks + embeddings (quando configurados). */
export async function ingestBook(
  campaignId: string,
  title: string,
  filename: string,
  buf: Buffer
): Promise<{ bookId: string; pages: number; chunks: number }> {
  const pages = await extractPages(filename, buf);
  if (!pages.length) throw new Error("Nenhum texto extraído do arquivo.");
  const rows = await q<{ id: string }>(
    `INSERT INTO books (campaign_id, title, pages) VALUES ($1,$2,$3) RETURNING id`,
    [campaignId, title, pages.length]
  );
  const bookId = rows[0].id;

  const allChunks: { page: number; index: number; content: string }[] = [];
  for (let i = 0; i < pages.length; i++) {
    await q(`INSERT INTO book_pages (book_id, page, content) VALUES ($1,$2,$3)`, [
      bookId,
      i + 1,
      pages[i],
    ]);
    chunkPage(pages[i]).forEach((c, idx) =>
      allChunks.push({ page: i + 1, index: idx, content: c })
    );
  }

  const vectorOk = await hasVector();
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const vecs = vectorOk ? await embed(batch.map((c) => c.content)) : null;
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      if (vecs?.[j]) {
        await q(
          `INSERT INTO book_chunks (book_id, page, chunk_index, content, embedding)
           VALUES ($1,$2,$3,$4,$5)`,
          [bookId, c.page, c.index, c.content, toVectorLiteral(vecs[j])]
        );
      } else {
        await q(
          `INSERT INTO book_chunks (book_id, page, chunk_index, content)
           VALUES ($1,$2,$3,$4)`,
          [bookId, c.page, c.index, c.content]
        );
      }
    }
  }
  return { bookId, pages: pages.length, chunks: allChunks.length };
}

export async function readPages(
  bookId: string,
  from: number,
  to: number
): Promise<{ page: number; content: string }[]> {
  const capped = Math.min(to, from + 7); // máx 8 páginas por chamada
  return q<{ page: number; content: string }>(
    `SELECT page, content FROM book_pages
     WHERE book_id = $1 AND page BETWEEN $2 AND $3 ORDER BY page`,
    [bookId, from, capped]
  );
}

export async function listBooks(
  campaignId: string
): Promise<{ id: string; title: string; pages: number }[]> {
  return q(
    `SELECT id, title, pages FROM books WHERE campaign_id = $1 ORDER BY created_at`,
    [campaignId]
  ) as Promise<{ id: string; title: string; pages: number }[]>;
}

import { getAdvanced } from "./advanced";
import { hasVector, q } from "./db";
import { embed, toVectorLiteral } from "./embeddings";

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

/** Chunks de uma página: até size chars, cortando no último ". " depois da metade; o seguinte repete os últimos overlap chars. */
export function chunkPage(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const cut = text.lastIndexOf(". ", end);
      if (cut > start + size / 2) end = cut + 1;
    }
    chunks.push(text.slice(start, end).trim());
    // end > start + size/2 e overlap <= size/2 (normalizeAdvanced): sempre anda
    start = end < text.length ? end - overlap : end;
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
  const [pages, adv] = await Promise.all([extractPages(filename, buf), getAdvanced()]);
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
    chunkPage(pages[i], adv.books.chunkChars, adv.books.overlapChars).forEach((c, idx) =>
      allChunks.push({ page: i + 1, index: idx, content: c })
    );
  }

  const vectorOk = await hasVector();
  for (let i = 0; i < allChunks.length; i += adv.embeddings.batch) {
    const batch = allChunks.slice(i, i + adv.embeddings.batch);
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
  const capped = Math.min(to, from + (await getAdvanced()).books.maxPages - 1);
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

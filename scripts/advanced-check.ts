/**
 * Verificação das Configurações avançadas (lib/advanced.ts) e do que elas mexem: normalização e limites, cache,
 * chunking com size/overlap, o parâmetro dimensions no POST /embeddings, a busca com vetores de dimensões misturadas
 * e o reprocessamento (refaz o chunking dos livros, avisa quando o modelo ignora dimensions). Sem IA nem rede (fetch
 * falso). Roda num banco descartável no mesmo Postgres (o reprocessamento mexe em todas as campanhas), apagado no fim.
 * Rodar: npx tsx scripts/advanced-check.ts
 */
import assert from "node:assert/strict";
import { Client } from "pg";
import { ADVANCED_DEFAULTS as D, getAdvanced, normalizeAdvanced, saveAdvanced } from "../src/lib/advanced";
import { chunkPage, ingestBook } from "../src/lib/books";
import { getSetting, pool, q, setSetting } from "../src/lib/db";
import { embed } from "../src/lib/embeddings";
import { searchBookChunks, searchHistory, searchMemories } from "../src/lib/retrieval";
import { HISTORY_MIN, MEMORY_MIN } from "../src/lib/decisions";
import { POST as reprocess } from "../src/app/api/embeddings/reprocess/route";

const BASE = process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg";
const TEST_DB = "rpg_advanced_check";
process.env.DATABASE_URL = BASE.replace(/\/[^/]*$/, `/${TEST_DB}`); // db.ts só lê na primeira consulta
process.env.OPENROUTER_API_KEY = "sk-check"; // getSource("openrouter") exige chave

// "modelo" falso: devolve [1, 0, 0, ...] com `out` dimensões, ignorando o dimensions pedido
let out = 3;
const bodies: { model: string; input: string[]; dimensions?: number }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  assert.ok(String(url).endsWith("/embeddings"), String(url));
  const body = JSON.parse(String(init?.body));
  bodies.push(body);
  const data = body.input.map((_: string, index: number) => ({ index, embedding: Array.from({ length: out }, (_, i) => (i ? 0 : 1)) }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

const expire = () => ((globalThis as unknown as { __advanced?: { at: number } }).__advanced!.at = 0);

/** O chunking de antes das Configurações avançadas (2400 chars, sem overlap), para comparar. */
function oldChunkPage(text: string): string[] {
  if (text.length <= 2400) return text ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 2400, text.length);
    if (end < text.length) {
      const cut = text.lastIndexOf(". ", end);
      if (cut > start + 1200) end = cut + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

async function main() {
  // ---------- sem banco: padrões, normalização, chunking ----------
  // padrões = os valores fixos de antes (nada muda para quem não mexer)
  assert.deepEqual(
    [D.memory.topK, D.memory.recentK, D.memory.maxDistance, D.memory.toolTopK, D.memory.npcTopK, D.memory.alwaysKeep],
    [6, 8, 2, 8, 8, 5]
  );
  assert.deepEqual([D.history.excerptChars, D.history.toolTopK, D.history.autoTopK, D.history.autoMaxDistance, D.history.batch], [700, 4, 2, 0.45, 16]);
  assert.deepEqual([D.books.chunkChars, D.books.overlapChars, D.books.topK, D.books.maxPages], [2400, 0, 5, 8]);
  assert.deepEqual([D.embeddings.dimensions, D.embeddings.batch], [0, 64]);
  assert.deepEqual(D.jev, { complexMin: 0.5, webMin: 0.7, npcWillingMin: 0.4, presentMin: 0.4, movedMin: 0.5, genderMin: 0.7 });
  assert.deepEqual([MEMORY_MIN, HISTORY_MIN], [0.55, 0.8]);

  assert.deepEqual(normalizeAdvanced(undefined), D);
  assert.deepEqual(normalizeAdvanced("lixo"), D);
  const n = normalizeAdvanced({
    memory: { topK: "abc", recentK: null, maxDistance: -1, jevMin: "0.123456" },
    history: { autoMaxDistance: "0.3", autoTopK: 2.6, excerptChars: Infinity },
    books: { chunkChars: 1e9, overlapChars: 99999 },
    embeddings: { dimensions: 512.4, batch: 0 },
    jev: { complexMin: 1.7 },
    bogus: { x: 1 },
  }) as unknown as Record<string, Record<string, number>>;
  assert.equal(n.memory.topK, 6, "lixo vira o padrão");
  assert.equal(n.memory.recentK, 8, "null vira o padrão");
  assert.equal(n.memory.maxDistance, 0, "abaixo da faixa prende no mínimo");
  assert.equal(n.memory.jevMin, 0.1235, "fração com 4 casas");
  assert.equal(n.history.autoMaxDistance, 0.3, "texto numérico vale");
  assert.equal(n.history.autoTopK, 3, "inteiro arredonda");
  assert.equal(n.history.excerptChars, 700, "infinito vira o padrão");
  assert.equal(n.books.chunkChars, 12000, "acima da faixa prende no máximo");
  assert.equal(n.books.overlapChars, 6000);
  assert.equal(n.embeddings.dimensions, 512);
  assert.equal(n.embeddings.batch, 1);
  assert.equal(n.jev.complexMin, 1);
  assert.equal(n.bogus, undefined, "grupo desconhecido sai");
  assert.equal(normalizeAdvanced({ books: { chunkChars: 1000, overlapChars: 900 } }).books.overlapChars, 500, "overlap até metade do chunk");

  // chunking: sem overlap é o de antes; com overlap repete o fim do anterior e sempre anda
  const prose = Array.from({ length: 220 }, (_, i) => `Frase número ${i} do livro de teste, com algum texto a mais.`).join(" ");
  assert.deepEqual(chunkPage(prose, 2400, 0), oldChunkPage(prose));
  assert.deepEqual(chunkPage("curto", 2400, 0), ["curto"]);
  assert.deepEqual(chunkPage("", 2400, 0), []);
  const plain = "abcdefghijklmnopqrstuvwxyz".repeat(40); // sem ". " nem espaço: corte exato
  const ov = chunkPage(plain, 100, 30);
  assert.ok(ov.every((c) => c.length <= 100));
  for (let i = 1; i < ov.length; i++) assert.ok(ov[i].startsWith(ov[i - 1].slice(-30)), `chunk ${i} repete o fim do anterior`);
  assert.equal(ov[0] + ov.slice(1).map((c) => c.slice(30)).join(""), plain, "nada se perde");
  const max = chunkPage(prose, 200, 100); // overlap máximo: termina
  assert.ok(max.length > prose.length / 200 && max.every((c) => c.length <= 200));
  const sent = chunkPage(prose, 500, 120);
  assert.ok(sent.every((c) => c.length <= 500) && sent.slice(0, -1).every((c) => c.endsWith(".")), "com overlap ainda corta no fim da frase");

  // ---------- banco descartável ----------
  const admin = new Client({ connectionString: BASE });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  try {
    await setSetting("embeddings", { enabled: true, model: "fake/embed", source: "openrouter" });

    // cache: lê uma vez; escrita por fora só aparece quando expira; salvar troca na hora e grava só o que difere
    assert.deepEqual(await getAdvanced(), D);
    await setSetting("advanced", { memory: { topK: 9 } });
    assert.equal((await getAdvanced()).memory.topK, 6, "dentro do TTL vale o cache");
    expire();
    assert.equal((await getAdvanced()).memory.topK, 9, "expirou: relê o banco");
    const saved = await saveAdvanced({ ...D, memory: { ...D.memory, topK: 7 }, books: { ...D.books, maxPages: 999 } });
    assert.equal(saved.books.maxPages, 50);
    assert.equal((await getAdvanced()).memory.topK, 7, "salvar troca o cache na hora");
    assert.deepEqual(await getSetting("advanced", {}), { memory: { topK: 7 }, books: { maxPages: 50 } }, "grava só o que difere do padrão");
    expire();
    assert.equal((await getAdvanced()).memory.topK, 7);

    // dimensions: só vai no request quando > 0
    await saveAdvanced({});
    assert.deepEqual(await getSetting("advanced", {}), {});
    await embed(["a"]);
    assert.equal(bodies.at(-1)!.model, "fake/embed");
    assert.ok(!("dimensions" in bodies.at(-1)!), "0 = dimensão nativa, sem o parâmetro");
    await saveAdvanced({ embeddings: { dimensions: 256 } });
    await embed(["a"]);
    assert.equal(bodies.at(-1)!.dimensions, 256);
    await saveAdvanced({});

    // busca com dimensões misturadas (trocou modelo/dimensões e ainda não reprocessou): só compara as da consulta
    const [{ id: cid }] = await q<{ id: string }>(`INSERT INTO campaigns (name, ruleset) VALUES ('[teste-avancadas]', '{}') RETURNING id`);
    const mem = (content: string, v: string) =>
      q(`INSERT INTO memories (campaign_id, kind, content, embedding) VALUES ($1, 'event', $2, $3)`, [cid, content, v]);
    await mem("perto", "[1,0,0]");
    await mem("longe", "[0,1,0]");
    await mem("outra dimensão", "[1,0,0,0]");
    const [{ id: bookId }] = await q<{ id: string }>(`INSERT INTO books (campaign_id, title, pages) VALUES ($1, 'Sem páginas', 0) RETURNING id`, [cid]);
    await q(
      `INSERT INTO book_chunks (book_id, page, chunk_index, content, embedding) VALUES ($1, 1, 0, 'c3', '[1,0,0]'), ($1, 1, 1, 'c4', '[1,0,0,0]')`,
      [bookId]
    );
    const [npc] = await q<{ id: string }>(`INSERT INTO characters (campaign_id, kind, name) VALUES ($1, 'npc', 'Iruka') RETURNING id`, [cid]);
    const chats = await q<{ id: string }>(
      `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content)
       SELECT $1, $2, gen_random_uuid(), 'npc', x FROM unnest(ARRAY['h perto','h longe','h outra']) x RETURNING id`,
      [cid, npc.id]
    );
    for (const [i, v] of ["[1,0,0]", "[0,1,0]", "[1,0,0,0]"].entries())
      await q(`INSERT INTO history_chunks (campaign_id, npc_chat_id, npc, content, embedding) VALUES ($1, $2, 'Iruka', $3, $4)`, [
        cid, chats[i].id, ["h perto", "h longe", "h outra"][i], v,
      ]);

    out = 3;
    assert.deepEqual((await searchMemories(cid, "q")).map((m) => m.content), ["perto", "longe"]);
    assert.deepEqual((await searchMemories(cid, "q", { maxDistance: 0.5 })).map((m) => m.content), ["perto"], "limiar de distância");
    assert.deepEqual((await searchBookChunks(cid, "q", 5)).map((c) => c.content), ["c3"]);
    assert.deepEqual((await searchHistory(cid, "q")).map((h) => h.content), ["h perto", "h longe"]);
    assert.deepEqual((await searchHistory(cid, "q", { auto: true })).map((h) => h.content), ["h perto"], "auto: até 0,45");
    await saveAdvanced({ history: { autoMaxDistance: 1 } });
    assert.deepEqual((await searchHistory(cid, "q", { auto: true })).map((h) => h.content), ["h perto", "h longe"], "auto: limiar das avançadas");
    out = 4;
    assert.deepEqual((await searchMemories(cid, "q")).map((m) => m.content), ["outra dimensão"]);
    assert.deepEqual((await searchBookChunks(cid, "q", 5)).map((c) => c.content), ["c4"]);
    assert.deepEqual((await searchHistory(cid, "q", { auto: true })).map((h) => h.content), ["h outra"]);
    out = 7; // ninguém nessa dimensão: memórias caem no full-text, a automática não devolve nada
    assert.deepEqual((await searchMemories(cid, "longe")).map((m) => m.content), ["longe"]);
    assert.deepEqual(await searchHistory(cid, "q", { auto: true }), []);

    // livro indexado com os padrões; reprocessar com outro chunk size/overlap refaz os chunks a partir das páginas
    out = 3;
    const book = await ingestBook(cid, "Livro", "livro.txt", Buffer.from(prose));
    const page = (await q<{ content: string }>(`SELECT content FROM book_pages WHERE book_id = $1`, [book.bookId]))[0].content;
    assert.equal(book.chunks, chunkPage(page, 2400, 0).length);
    await saveAdvanced({ books: { chunkChars: 1000, overlapChars: 200 }, embeddings: { dimensions: 8, batch: 2 } });
    out = 5; // o "modelo" ignora dimensions=8
    const before = bodies.length;
    const res = await reprocess();
    const d = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    const want = chunkPage(page, 1000, 200);
    assert.equal(d.book_chunks, want.length, "livro sem páginas perde os chunks; o com páginas é refeito");
    assert.deepEqual(
      (await q<{ content: string }>(`SELECT content FROM book_chunks WHERE book_id = $1 ORDER BY page, chunk_index`, [book.bookId])).map((r) => r.content),
      want
    );
    assert.equal(d.memories, 3);
    assert.equal(d.history_chunks, 3);
    assert.equal(d.dims, 5);
    assert.match(d.warning, /ignorou dimensions=8 e devolveu 5/);
    const dims = await q<{ d: number }>(
      `SELECT DISTINCT vector_dims(embedding) AS d FROM (SELECT embedding FROM memories UNION ALL SELECT embedding FROM book_chunks UNION ALL SELECT embedding FROM history_chunks) x`
    );
    assert.deepEqual(dims, [{ d: 5 }], "tudo na dimensão nova, sem vetor nulo");
    const calls = bodies.slice(before);
    assert.ok(calls.every((b) => b.dimensions === 8), "dimensions das avançadas");
    assert.deepEqual(calls.map((b) => b.input.length), [2, 1, ...want.map((_, i) => (i % 2 ? 0 : Math.min(2, want.length - i))).filter(Boolean), 3], "batch 2 em memórias e livros, 16 no histórico");
    await saveAdvanced({ books: { chunkChars: 1000, overlapChars: 200 } });
    assert.equal((await (await reprocess()).json()).warning, undefined, "sem dimensions pedido não há aviso");

    console.log("advanced-check: ok");
  } finally {
    await pool().end();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

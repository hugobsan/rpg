import { ADVANCED_DEFAULTS, getAdvanced } from "./advanced";
import { hasVector, q } from "./db";
import { embed, toVectorLiteral } from "./embeddings";
import { formatClock } from "./clock";

export interface ChunkHit {
  book_id: string;
  title: string;
  page: number;
  content: string;
}

/** Grava uma diretriz do jogador (memories só guarda diretrizes; os fatos da história ficam em events, lib/knowledge). */
export async function addMemory(campaignId: string, kind: string, content: string, subject?: string | null, importance = 3): Promise<number> {
  const rows = await q<{ id: number }>(
    `INSERT INTO memories (campaign_id, kind, subject, content, importance) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [campaignId, kind, subject || null, content, importance]
  );
  return rows[0].id;
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
         WHERE b.campaign_id = $1 AND vector_dims(c.embedding) = $4
         ORDER BY c.embedding <=> $2 LIMIT $3`,
        [campaignId, toVectorLiteral(vecs[0]), limit, vecs[0].length]
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

// ---------- histórico vetorial (4ª camada): o chat inteiro em trechos, consultado por search_history ----------

export interface HistoryHit {
  id: number;
  npc: string | null;
  clock: number | null;
  location: string | null;
  content: string;
}

type ChatRow = { id: number; role: string; content: string };
export interface HistoryChunk {
  message_id: number | null;
  npc_chat_id: number | null;
  npc: string | null;
  location: string | null;
  content: string;
}

/**
 * Trechos do chat: turno = falas do jogador desde a narração anterior + a narração do Mestre; conversa com NPC =
 * falas do jogador desde a resposta anterior da sessão + a resposta do NPC. Fala do jogador ainda sem resposta fica de fora.
 */
export function historyChunks(
  msgs: (ChatRow & { location: string | null })[],
  chats: (ChatRow & { session_id: string; npc: string })[]
): HistoryChunk[] {
  const said = (texts: string[] = []) => (texts.length ? `Jogador: ${texts.join(" / ").replace(/\s+/g, " ").trim()}\n` : "");
  const out: HistoryChunk[] = [];
  let player: string[] = [];
  for (const m of msgs)
    if (m.role === "player") player.push(m.content);
    else if (m.role === "gm") {
      out.push({ message_id: m.id, npc_chat_id: null, npc: null, location: m.location, content: `${said(player)}Mestre: ${m.content}` });
      player = [];
    }
  const pending = new Map<string, string[]>();
  for (const c of chats)
    if (c.role === "player") pending.set(c.session_id, [...(pending.get(c.session_id) || []), c.content]);
    else {
      out.push({ message_id: null, npc_chat_id: c.id, npc: c.npc, location: null, content: `${said(pending.get(c.session_id))}${c.npc}: ${c.content}` });
      pending.delete(c.session_id);
    }
  return out;
}

/**
 * Grava em history_chunks os turnos e as trocas com NPC posteriores aos já gravados, com embedding quando houver
 * (sem embeddings fica o texto e a busca cai no full-text). now = carimba a hora do jogo atual (e o local atual na
 * conversa com NPC): é o turno que acabou de acontecer; false = histórico antigo, sem hora registrada (backfill).
 */
export async function indexHistory(campaignId: string, now = true): Promise<number> {
  const [msgs, chats, [cur]] = await Promise.all([
    q<ChatRow & { location: string | null }>(
      `SELECT m.id, m.role, m.content, s.location FROM messages m LEFT JOIN scenes s ON s.id = m.scene_id
       WHERE m.campaign_id = $1 AND m.role IN ('player','gm')
         AND m.id > (SELECT COALESCE(MAX(message_id), 0) FROM history_chunks WHERE campaign_id = $1)
       ORDER BY m.id`,
      [campaignId]
    ),
    q<ChatRow & { session_id: string; npc: string }>(
      `SELECT n.id, n.session_id, n.role, n.content, c.name AS npc FROM npc_chats n JOIN characters c ON c.id = n.npc_id
       WHERE n.campaign_id = $1 AND n.id > (SELECT COALESCE(MAX(npc_chat_id), 0) FROM history_chunks WHERE campaign_id = $1)
       ORDER BY n.id`,
      [campaignId]
    ),
    q<{ clock: number | null; location: string | null }>(
      `SELECT (state->'clock'->>'minutes')::numeric::int AS clock,
              (SELECT location FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1) AS location
       FROM campaigns WHERE id = $1`,
      [campaignId]
    ),
  ]);
  const added: { id: number; content: string }[] = [];
  for (const c of historyChunks(msgs, chats)) {
    // ON CONFLICT: o fim do turno e uma conversa com NPC podem indexar ao mesmo tempo
    const [row] = await q<{ id: number; content: string }>(
      `INSERT INTO history_chunks (campaign_id, message_id, npc_chat_id, npc, clock, location, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id, content`,
      [campaignId, c.message_id, c.npc_chat_id, c.npc, now ? cur?.clock ?? null : null, c.location ?? (now ? cur?.location : null) ?? null, c.content]
    );
    if (row) added.push(row);
  }
  const size = (await getAdvanced()).history.batch;
  if (added.length && (await hasVector()))
    for (let i = 0; i < added.length; i += size) {
      const batch = added.slice(i, i + size);
      const vecs = await embed(batch.map((r) => r.content));
      if (!vecs) break;
      for (const [j, r] of batch.entries())
        if (vecs[j]) await q(`UPDATE history_chunks SET embedding = $1 WHERE id = $2`, [toVectorLiteral(vecs[j]), r.id]);
    }
  return added.length;
}

/** Prefixos (5 letras) das palavras de 4+ letras da busca: "perguntei" acha "pergunta". */
export const queryTerms = (query: string) => [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map((w) => w.slice(0, 5)))];

/**
 * Busca no histórico: vetorial quando há embeddings, senão full-text (qualquer termo, por relevância). npc = só trechos
 * com ele (conversa particular ou turno que o cita).
 */
export async function searchHistory(
  campaignId: string,
  query: string,
  opts: { npc?: string; limit?: number } = {}
): Promise<HistoryHit[]> {
  const cols = `h.id, h.npc, h.clock, h.location, h.content`;
  const params: unknown[] = [campaignId, opts.limit ?? 4];
  let where = "h.campaign_id = $1";
  const name = opts.npc?.trim().split(/[\s-]/)[0]; // "Iruka-sensei" → Iruka
  if (name) {
    params.push(name);
    where += ` AND (h.npc ILIKE '%' || $3 || '%' OR h.content ILIKE '%' || $3 || '%')`;
  }

  if (await hasVector()) {
    const vecs = await embed([query]);
    if (vecs?.[0]) {
      const n = params.length;
      params.push(toVectorLiteral(vecs[0]), vecs[0].length);
      // só a mesma dimensão (o <=> com outra dimensão dá erro)
      const rows = await q<HistoryHit>(
        `SELECT ${cols} FROM history_chunks h WHERE ${where} AND vector_dims(h.embedding) = $${n + 2}
         ORDER BY h.embedding <=> $${n + 1} LIMIT $2`,
        params
      );
      if (rows.length) return rows;
      params.splice(n); // sem embeddings gravados ainda (ou de outra dimensão): cai para FTS
    }
  }
  const terms = queryTerms(query);
  if (!terms.length) return [];
  params.push(terms.map((t) => `${t}:*`).join(" | "));
  const tq = `to_tsquery('simple', $${params.length})`;
  return q<HistoryHit>(
    `SELECT ${cols} FROM history_chunks h WHERE ${where} AND to_tsvector('simple', h.content) @@ ${tq}
     ORDER BY ts_rank(to_tsvector('simple', h.content), ${tq}) DESC, h.id DESC LIMIT $2`,
    params
  );
}

/**
 * Corte curto, até ~max caracteres: a janela de frases que cobre mais termos distintos da busca (empate: mais
 * acertos). A linha do jogador (a ação, até 200) e quem responde ("Mestre:", "Nome do NPC:") ficam sempre.
 */
export function excerpt(text: string, query: string, max = ADVANCED_DEFAULTS.history.excerptChars): string {
  if (text.length <= max) return text;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
  const nl = text.indexOf("\n");
  const head = text.startsWith("Jogador: ") && nl > 0 ? cut(text.slice(0, nl), 200) + "\n" : "";
  const body = head ? text.slice(nl + 1) : text;
  const colon = body.indexOf(": ");
  const label = colon > 0 && colon < 60 ? body.slice(0, colon + 2) : "";
  const parts = body.slice(label.length).match(/[^.!?\n]+[.!?…"”»)*]*\s*/g) || [];
  const room = Math.max(200, max - head.length - label.length);
  const terms = queryTerms(query);
  const hits = parts.map((p) => terms.filter((t) => p.toLowerCase().includes(t)));
  let [a, b, best] = [0, 1, -1];
  for (let i = 0; i < parts.length; i++) {
    let j = i;
    for (let len = 0; j < parts.length && len + parts[j].length <= room; ) len += parts[j++].length;
    const got = hits.slice(i, Math.max(j, i + 1)).flat();
    const score = new Set(got).size * 1000 + got.length;
    if (score > best) [a, b, best] = [i, Math.max(j, i + 1), score];
  }
  return `${head}${label}${a > 0 ? "…" : ""}${cut(parts.slice(a, b).join("").trim(), room)}${b < parts.length ? "…" : ""}`;
}

/** "[Dia 2 · 14:00, Konoha, conversa particular com Iruka]" + o corte. */
export function historyLine(h: HistoryHit, query: string, max?: number): string {
  const when = [h.clock == null ? "hora não registrada" : formatClock(h.clock), h.location, h.npc && `conversa particular com ${h.npc}`];
  return `[${when.filter(Boolean).join(", ")}]\n${excerpt(h.content, query, max)}`;
}

/** O que vai ao Mestre (search_history e trechos lembrados no turno). */
export function formatHistory(hits: HistoryHit[], query: string, max?: number): string {
  return [
    "Trechos do chat: é o que aconteceu naquele momento; se discordarem da ficha ou dos fatos atuais, valem a ficha e os fatos.",
    ...hits.map((h) => historyLine(h, query, max)),
  ].join("\n---\n");
}

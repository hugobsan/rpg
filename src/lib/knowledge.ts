import { hasVector, q } from "./db";
import { embed, toVectorLiteral } from "./embeddings";
import { clockParts, period } from "./clock";
import { queryTerms } from "./retrieval";
import { fold, resolveName } from "./contracts";

/**
 * Memória por testemunha: cada fato é uma linha em events e quem sabe dele, uma linha em knowledge. Quem estava na cena
 * no fim do turno testemunhou (código, não o modelo); told = alguém contou (inclusive o personagem do jogador); public
 * = anúncio ou boato (events.public: quem entrar na história depois também sabe). O Narrador recebe, por NPC em cena,
 * o bloco SABE só dele; o agente NPC recebe o mesmo bloco na conversa particular.
 * Verificação sem IA: npx tsx scripts/knowledge-check.ts
 */

export type Access = "witnessed" | "told" | "public";
export interface Known {
  id: number;
  text: string;
  minute: number | null;
  access: Access;
  from: string | null;
}
type Row = Known & { score: number | null };

/** Grava o fato (com embedding quando houver) e dá acesso a `know.ids`. */
export async function addEvent(
  campaignId: string,
  text: string,
  o: { sceneId?: string | null; messageId?: number | null; minute?: number | null; public?: boolean; know?: { ids: string[]; access: Access; from?: string | null } } = {}
): Promise<number> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO events (campaign_id, scene_id, message_id, minute, text, public) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [campaignId, o.sceneId ?? null, o.messageId || null, o.minute ?? null, text, !!o.public]
  );
  const id = Number(row.id);
  if (o.know?.ids.length) await grant(id, o.know.ids, o.know.access, o.know.from);
  if (await hasVector()) {
    const v = await embed([text]);
    if (v?.[0]) await q(`UPDATE events SET embedding = $1 WHERE id = $2`, [toVectorLiteral(v[0]), id]).catch(() => {});
  }
  return id;
}

/** Acesso de quem ainda não sabia (quem já sabia fica como estava: as linhas só entram). */
export async function grant(eventId: number, ids: string[], access: Access, from?: string | null): Promise<void> {
  if (!ids.length) return;
  await q(
    `INSERT INTO knowledge (event_id, character_id, access, from_name) SELECT $1, unnest($2::uuid[]), $3, $4 ON CONFLICT DO NOTHING`,
    [eventId, [...new Set(ids)], access, from ?? null]
  );
}

/** Quem está na cena agora: o personagem do jogador e os NPCs ativos. */
export async function sceneWitnesses(campaignId: string): Promise<string[]> {
  return (await q<{ id: string }>(`SELECT id FROM characters WHERE campaign_id = $1 AND (kind = 'player' OR active)`, [campaignId])).map((r) => r.id);
}

/** Fato novo: testemunhas = quem está na cena (ou `witnesses`, na conversa particular); public = todos, inclusive os de depois. */
export async function recordFact(
  campaignId: string,
  text: string,
  o: { public?: boolean; sceneId?: string | null; messageId?: number | null; minute?: number | null; witnesses?: string[] } = {}
): Promise<number> {
  const ids = o.witnesses ?? (await sceneWitnesses(campaignId));
  return addEvent(campaignId, text, { ...o, know: { ids, access: "witnessed" } });
}

/**
 * Alguém contou: casa com um fato que quem contou já sabe (por semelhança simples de palavras) ou grava um novo, que
 * quem contou passa a saber como dele. Só ouve quem está na cena (ou na conversa: `audience`). Devolve o evento e quem
 * ficou sabendo; null = quem contou ou os ouvintes não são personagens registrados.
 */
export async function recordTold(
  campaignId: string,
  fact: string,
  by: string,
  to: string[],
  o: { sceneId?: string | null; messageId?: number | null; minute?: number | null; audience?: string[]; location?: string } = {}
): Promise<{ eventId: number; heard: string[]; matched: boolean } | null> {
  const chars = await q<{ id: string; name: string }>(`SELECT id, name FROM characters WHERE campaign_id = $1`, [campaignId]);
  const idOf = (name: string) => {
    const n = resolveName(chars.map((c) => c.name), name, o.location);
    return n ? chars.find((c) => c.name === n)?.id : undefined;
  };
  const teller = idOf(by);
  const audience = new Set(o.audience ?? (await sceneWitnesses(campaignId)));
  const heard = to.map(idOf).filter((id): id is string => !!id && id !== teller && audience.has(id));
  if (!teller || !heard.length) return null;
  const names = [by, ...to].map((n) => fold(n).split(" ")[0]);
  const known = await q<{ id: string; text: string }>(
    `SELECT e.id, e.text FROM events e LEFT JOIN knowledge k ON k.event_id = e.id AND k.character_id = $2
     WHERE e.campaign_id = $1 AND (k.event_id IS NOT NULL OR e.public) ORDER BY e.id DESC LIMIT 300`,
    [campaignId, teller]
  );
  const best = known.map((e) => ({ id: Number(e.id), s: sameFact(fact, e.text, names) })).sort((a, b) => b.s - a.s)[0];
  const matched = !!best && best.s >= SAME_FACT_MIN;
  const eventId = matched
    ? best.id
    : await addEvent(campaignId, fact, { sceneId: o.sceneId, messageId: o.messageId, minute: o.minute, know: { ids: [teller], access: "witnessed" } });
  await grant(eventId, heard, "told", by);
  return { eventId, heard, matched };
}

// ponytail: semelhança por palavras (prefixo de 5 letras), sem os nomes de quem conta e de quem ouve; troca por
// embedding se "contou" começar a casar fato errado ou a duplicar
export const SAME_FACT_MIN = 0.6;
/** Coeficiente de sobreposição dos termos (|A∩B| / menor), com pelo menos 2 termos em comum; 0 = nada a ver. */
export function sameFact(a: string, b: string, skip: string[] = []): number {
  const terms = (t: string) => new Set(queryTerms(fold(t)).filter((w) => !skip.some((s) => s && s.startsWith(w))));
  const [x, y] = [terms(a), terms(b)];
  const common = [...x].filter((w) => y.has(w)).length;
  return common < 2 ? 0 : common / Math.min(x.size, y.size);
}

// ---------- o que cada um sabe ----------

/**
 * Até `limit` fatos: os 3 últimos que ele testemunhou, metade por relevância à busca (vetor ou full-text) e o resto
 * pelos mais recentes; em ordem cronológica. rows: do mais recente para o mais antigo.
 */
export function pickKnown(rows: Row[], limit: number, lastWitnessed = 3): Known[] {
  const out = new Map<number, Known>();
  const add = (r: Row) => {
    if (out.size < limit && !out.has(r.id)) out.set(r.id, { id: r.id, text: r.text, minute: r.minute, access: r.access, from: r.from });
  };
  rows.filter((r) => r.access === "witnessed").slice(0, lastWitnessed).forEach(add);
  rows
    .filter((r) => r.score !== null && r.score > 0)
    .sort((a, b) => b.score! - a.score!)
    .slice(0, Math.ceil(limit / 2))
    .forEach(add);
  rows.forEach(add);
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** "- [Dia 9, tarde] fato (contaram: Hugo)". */
export function knownLine(k: Known): string {
  const when = k.minute !== null && k.minute !== undefined ? `[Dia ${clockParts(k.minute).day}, ${period(k.minute)}] ` : "";
  const how = k.access === "told" ? ` (contaram${k.from ? `: ${k.from}` : ""})` : k.access === "public" ? " (boato)" : "";
  return `- ${when}${k.text}${how}`;
}

/** Pontuação de relevância (SQL) para a busca: similaridade de cosseno com embedding, senão ts_rank; null = sem busca. */
async function scorer(query: string): Promise<{ sql: string; params: unknown[] }> {
  if (query.trim() && (await hasVector())) {
    const v = await embed([query]);
    if (v?.[0]) return { sql: `CASE WHEN vector_dims(e.embedding) = $DIM THEN 1 - (e.embedding <=> $VEC) END`, params: [toVectorLiteral(v[0]), v[0].length] };
  }
  const terms = queryTerms(query);
  if (!terms.length) return { sql: "NULL::float", params: [] };
  return { sql: `ts_rank(e.tsv, to_tsquery('simple', $TQ))`, params: [terms.map((t) => `${t}:*`).join(" | ")] };
}

// ponytail: lê os 400 fatos mais recentes de cada um e escolhe em JS; índice por personagem se a campanha passar disso
async function rowsOf(campaignId: string, characterId: string, s: { sql: string; params: unknown[] }, extra = ""): Promise<Row[]> {
  const params: unknown[] = [campaignId, characterId, ...s.params];
  const sql = s.sql.replace("$VEC", "$3").replace("$DIM", "$4").replace("$TQ", "$3");
  return (
    await q<Omit<Row, "id"> & { id: string }>(
      `SELECT e.id, e.text, e.minute, COALESCE(k.access, 'public') AS access, k.from_name AS "from", (${sql})::float AS score
       FROM events e LEFT JOIN knowledge k ON k.event_id = e.id AND k.character_id = $2
       WHERE e.campaign_id = $1 AND (k.event_id IS NOT NULL OR e.public) ${extra}
       ORDER BY e.id DESC LIMIT 400`,
      params
    )
  ).map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * Contexto de memória do turno: o SABE de cada NPC (`npcIds`) e o que só o jogador sabe entre os fatos relevantes
 * (nenhum dos NPCs em cena sabe; fato público fica de fora, todos sabem). Uma busca de embedding para todos.
 */
export async function sceneKnowledge(
  campaignId: string,
  query: string,
  npcIds: string[],
  playerId: string | null,
  limit = 8
): Promise<{ sabe: Map<string, Known[]>; onlyPlayer: Known[] }> {
  const s = await scorer(query);
  const sabe = new Map<string, Known[]>();
  for (const id of npcIds) sabe.set(id, pickKnown(await rowsOf(campaignId, id, s), limit));
  let onlyPlayer: Known[] = [];
  if (playerId) {
    const rows = await q<Omit<Row, "id"> & { id: string }>(
      `SELECT e.id, e.text, e.minute, k.access, k.from_name AS "from", (${s.sql.replace("$VEC", "$4").replace("$DIM", "$5").replace("$TQ", "$4")})::float AS score
       FROM events e JOIN knowledge k ON k.event_id = e.id AND k.character_id = $2
       WHERE e.campaign_id = $1 AND NOT e.public
         AND NOT EXISTS (SELECT 1 FROM knowledge o WHERE o.event_id = e.id AND o.character_id = ANY($3::uuid[]))
       ORDER BY e.id DESC LIMIT 400`,
      [campaignId, playerId, npcIds, ...s.params]
    );
    onlyPlayer = pickKnown(rows.map((r) => ({ ...r, id: Number(r.id) })), 4, 1);
  }
  return { sabe, onlyPlayer };
}

/** SABE de um personagem só (agente NPC). */
export async function knowsOf(campaignId: string, characterId: string, query: string, limit = 8): Promise<Known[]> {
  return (await sceneKnowledge(campaignId, query, [characterId], null, limit)).sabe.get(characterId) ?? [];
}

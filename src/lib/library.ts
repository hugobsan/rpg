import { q } from "./db";
import type { Campaign, LibraryAbility, LibraryEntry, LibraryKind } from "./types";

/**
 * Biblioteca da campanha (tabela library): habilidades e itens do mundo/cânone.
 * Fonte para o Criador de personagens e para registrar técnicas sem inventar na hora.
 * Esqueleto: a frente da biblioteca completa (busca melhor, Criador de habilidades, geração em lote).
 */

export async function listLibrary(
  campaignId: string,
  kind: LibraryKind,
  opts: { query?: string; limit?: number } = {}
): Promise<LibraryEntry[]> {
  const rows = await q<LibraryEntry & { id: string }>(
    `SELECT id, kind, name, data, canon, source FROM library
      WHERE campaign_id = $1 AND kind = $2 AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
      ORDER BY name LIMIT $4`,
    [campaignId, kind, opts.query?.trim() || null, opts.limit ?? 500]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function findLibrary(campaignId: string, kind: LibraryKind, name: string): Promise<LibraryEntry | null> {
  const [r] = await q<LibraryEntry & { id: string }>(
    `SELECT id, kind, name, data, canon, source FROM library WHERE campaign_id = $1 AND kind = $2 AND lower(name) = lower($3)`,
    [campaignId, kind, name.trim()]
  );
  return r ? { ...r, id: Number(r.id) } : null;
}

/**
 * Habilidade pronta para a ficha: a da biblioteca ou, se não existir, criada agora pelo
 * Criador de habilidades a partir do brief (e guardada na biblioteca). null se não deu.
 */
export async function ensureAbility(campaign: Campaign, name: string, brief?: string): Promise<LibraryAbility | null> {
  void brief;
  const hit = await findLibrary(campaign.id, "ability", name);
  return hit ? (hit.data as LibraryAbility) : null;
}

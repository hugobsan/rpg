/**
 * Retrato de personagem (pixel art pelo Pixel artista, ou imagem pelo Ilustrador quando a geração
 * de imagens está ligada). Esqueleto: a frente de retratos implementa.
 */

/** Gera (ou regera, com force) o retrato do personagem em segundo plano (lib/jobs.ts). Não bloqueia. */
export async function queuePortrait(campaignId: string, characterId: string, opts: { force?: boolean } = {}): Promise<void> {
  void campaignId;
  void characterId;
  void opts;
}

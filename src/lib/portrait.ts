import { getSetting, q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { startJob } from "./jobs";
import type { Campaign, Character } from "./types";

/**
 * Retrato de personagem: o Ilustrador pinta com o modelo de imagem, só com a geração de imagens ligada.
 * Fica na tabela portraits (fora de characters, lida em todo turno); a tela usa a versão na URL.
 * Retratos antigos podem ser SVG (do Pixel artista, aposentado) e continuam valendo.
 */

/** Quem é o personagem, em texto curto e agnóstico de cenário (entra no prompt do Ilustrador). */
export function describe(campaign: Pick<Campaign, "ruleset">, c: Pick<Character, "name" | "kind" | "canon" | "sheet" | "persona">): string {
  const rs = campaign.ruleset;
  const rank = rs.ranks?.find((r) => r.key === c.sheet.rank)?.label || c.sheet.rank;
  const extra = Object.entries(c.sheet.extra || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${rs.extraFields?.find((f) => f.key === k)?.label || k}: ${v}`)
    .join("; ");
  const p = c.persona;
  return [
    `Cenário: ${rs.name}${rs.description ? `. ${rs.description}` : ""}`,
    `Personagem: ${c.name} (${c.kind === "player" ? "protagonista" : "NPC"}${c.canon ? ", personagem canônico da obra: siga a aparência oficial" : ""})`,
    rank && `Cargo: ${rank}`,
    extra,
    p.gender && `Sexo: ${p.gender === "female" ? "feminino" : "masculino"}`,
    `Aparência: ${p.appearance || "não descrita; invente uma coerente com o cenário e o papel"}`,
    p.personality && `Personalidade (para a expressão): ${p.personality.slice(0, 300)}`,
    p.backstory && `História: ${p.backstory.slice(0, 400)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Grava (ou troca) o retrato; cada troca sobe a versão, que vai na URL. */
export async function savePortrait(characterId: string, mime: string, data: Buffer): Promise<void> {
  await q(
    `INSERT INTO portraits (character_id, mime, data) VALUES ($1,$2,$3)
     ON CONFLICT (character_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data,
       version = portraits.version + 1, updated_at = now()`,
    [characterId, mime, data]
  );
}

const imageOn = async () => (await getSetting<{ imageGeneration?: boolean }>("ui", {})).imageGeneration !== false;
const OFF = "A geração de imagens está desligada nas Configurações: ligue para gerar o retrato.";

/** Gera agora (aguarda) com o Ilustrador. */
export async function drawPortrait(campaignId: string, characterId: string): Promise<void> {
  const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  const [c] = await q<Character>(`SELECT * FROM characters WHERE id = $1 AND campaign_id = $2`, [characterId, campaignId]);
  if (!campaign || !c) throw new Error("Personagem não encontrado.");
  const agent = await getAgent("image");
  const r = await chat({
    model: agent.model,
    messages: [{
      role: "user",
      content: `Retrato de busto de personagem de RPG em pixel art (estilo 16-bit, pixels grandes e nítidos, paleta limitada, contorno escuro), formato quadrado, rosto e ombros centralizados, fundo liso de uma cor só, sem texto e sem moldura. Roupa, cabelo e acessórios coerentes com o cenário e a época do mundo.\n\n${describe(campaign, c)}`,
    }],
    modalities: ["image", "text"],
    max_tokens: agent.max_tokens,
    temperature: agent.temperature,
    agentId: "image",
    campaignId,
    purpose: `retrato de ${c.name}`,
  });
  const m = r.images[0]?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  if (!m) throw new Error("O Ilustrador não devolveu imagem.");
  await savePortrait(c.id, m[1], Buffer.from(m[2], "base64"));
}

/** Gera (ou regera, com force) o retrato em segundo plano (lib/jobs.ts). Não bloqueia; lança com a geração desligada. */
export async function queuePortrait(campaignId: string, characterId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!(await imageOn())) throw new Error(OFF);
  const [c] = await q<{ name: string; has: boolean }>(
    `SELECT name, EXISTS (SELECT 1 FROM portraits WHERE character_id = $1) AS has
       FROM characters WHERE id = $1 AND campaign_id = $2`,
    [characterId, campaignId]
  );
  if (!c || (c.has && !opts.force)) return;
  await startJob(campaignId, "portrait", characterId, `Ilustrador pintando o retrato de ${c.name}`, () =>
    drawPortrait(campaignId, characterId)
  );
}

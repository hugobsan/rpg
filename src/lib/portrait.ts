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

/**
 * data URL de imagem (png, jpeg, webp, gif ou svg; em base64 ou em texto) → tipo e bytes; null se não for imagem.
 * Só esses tipos: as rotas servem os bytes com o tipo daqui, e um data:text/html viraria página no nosso domínio.
 */
export function imageFromDataUrl(url: string): { mime: string; data: Buffer } | null {
  const m = url.match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml))((?:;[^;,]+)*),(.*)$/s);
  if (!m) return null;
  if (/;base64/i.test(m[2])) return { mime: m[1], data: Buffer.from(m[3], "base64") };
  let text = m[3];
  try {
    text = decodeURIComponent(text);
  } catch {} // SVG cru com % solto: vale como veio
  return { mime: m[1], data: Buffer.from(text) };
}

const REWRITE = `Reescreva o pedido de ilustração abaixo como um prompt para um modelo de geração de imagem, em inglês, com até 80 palavras. Mantenha o estilo pedido (ex.: pixel art 16-bit, anime cinematográfico), o enquadramento e o formato; descreva só o que se vê: quem aparece e sua aparência concreta, roupa, expressão, o lugar, a luz e o clima. Troque nomes de obras, franquias e personagens por descrição visual (ex.: "ninja de cabelo prateado espetado, máscara cobrindo a boca, bandana com placa de metal"): vários modelos de imagem bloqueiam esses nomes na moderação. Sem texto na imagem. Responda só o prompt.`;

/**
 * Prompt do Ilustrador. Com params.promptModel (modelo de texto da mesma fonte), ele é reescrito curto e em inglês antes:
 * os modelos de difusão (FLUX, Recraft...) rendem mais assim do que com a narração longa em português. Falhou = o original.
 */
export async function imagePrompt(agent: Awaited<ReturnType<typeof getAgent>>, prompt: string, campaignId: string): Promise<string> {
  const model = String(agent.params.promptModel ?? "").trim();
  if (!model) return prompt;
  try {
    const r = await chat({
      model,
      messages: [{ role: "system", content: REWRITE }, { role: "user", content: prompt }],
      max_tokens: 2000, // modelo que raciocina gasta antes da resposta curta
      temperature: 0.3,
      agentId: "image",
      campaignId,
      purpose: "prompt da imagem (reescrita)",
    });
    return r.content.trim() || prompt;
  } catch {
    return prompt;
  }
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
      content: await imagePrompt(
        agent,
        `Retrato de busto de personagem de RPG em pixel art (estilo 16-bit, pixels grandes e nítidos, paleta limitada, contorno escuro), formato quadrado, rosto e ombros centralizados, fundo liso de uma cor só, sem texto e sem moldura. Roupa, cabelo e acessórios coerentes com o cenário e a época do mundo.\n\n${describe(campaign, c)}`,
        campaignId
      ),
    }],
    modalities: ["image", "text"],
    max_tokens: agent.max_tokens,
    temperature: agent.temperature,
    agentId: "image",
    campaignId,
    purpose: `retrato de ${c.name}`,
  });
  const img = r.images[0] ? imageFromDataUrl(r.images[0]) : null;
  if (!img) throw new Error("O Ilustrador não devolveu imagem.");
  await savePortrait(c.id, img.mime, img.data);
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

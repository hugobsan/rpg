import { getSetting, q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { startJob } from "./jobs";
import type { Campaign, Character } from "./types";

/**
 * Retrato de personagem: com a geração de imagens ligada, o Ilustrador pinta em estilo pixel art;
 * desligada, o Pixel artista devolve uma grade de pixels que vira SVG aqui (nunca SVG livre do modelo).
 * Fica na tabela portraits (fora de characters, lida em todo turno); a tela usa a versão na URL.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/** Grade do Pixel artista ({palette, rows}) → SVG com um path por cor, linhas mescladas. Lança se não vale. */
export function gridToSvg(raw: string): string {
  let data: { palette?: unknown; rows?: unknown };
  try {
    data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); // tolera texto ou cerca em volta
  } catch {
    throw new Error("O Pixel artista não devolveu um JSON válido.");
  }
  const { palette, rows } = data;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) throw new Error("Retrato sem paleta.");
  const colors = new Map<string, string>();
  for (const [k, c] of Object.entries(palette)) {
    if (k.length !== 1 || k === "." || k === " " || typeof c !== "string" || !HEX.test(c))
      throw new Error(`Cor inválida na paleta: ${JSON.stringify(k)} = ${JSON.stringify(c)}`);
    colors.set(k, c.toLowerCase());
  }
  if (colors.size < 2 || colors.size > 24) throw new Error(`Paleta com ${colors.size} cores (2 a 24).`);
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === "string")) throw new Error("Retrato sem linhas.");
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  if (h < 16 || h > 64 || w < 16 || w > 64) throw new Error(`Grade de ${w}×${h} (16 a 64 por lado).`);
  // o modelo erra a contagem às vezes: linha 1 ou 2 pixels mais curta completa com transparente
  const bad = rows.findIndex((r) => r.length < w - 2);
  if (bad >= 0) throw new Error(`Linha ${bad + 1} com ${rows[bad].length} pixels (as outras têm ${w}).`);

  const paths = new Map<string, string>();
  let filled = 0;
  let unknown = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let n = 1;
      while (row[x + n] === ch) n++;
      const color = colors.get(ch);
      if (color) {
        paths.set(color, `${paths.get(color) ?? ""}M${x} ${y}h${n}v1h-${n}z`);
        filled += n;
      } else if (ch !== "." && ch !== " ") unknown += n;
      x += n;
    }
  });
  if (unknown > w * h * 0.02) throw new Error(`${unknown} pixels com caractere fora da paleta.`);
  if (filled < w * h * 0.1) throw new Error("Retrato quase vazio.");
  const body = [...paths].map(([c, d]) => `<path fill="${c}" d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`;
}

/** Quem é o personagem, em texto curto e agnóstico de cenário (entra no prompt dos dois caminhos). */
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

/** Gera agora (aguarda). `image` força o caminho; sem ele vale a configuração ui.imageGeneration. */
export async function drawPortrait(campaignId: string, characterId: string, opts: { image?: boolean } = {}): Promise<void> {
  const [campaign] = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  const [c] = await q<Character>(`SELECT * FROM characters WHERE id = $1 AND campaign_id = $2`, [characterId, campaignId]);
  if (!campaign || !c) throw new Error("Personagem não encontrado.");
  const who = describe(campaign, c);

  if (opts.image ?? (await imageOn())) {
    const agent = await getAgent("image");
    const r = await chat({
      model: agent.model,
      messages: [{
        role: "user",
        content: `Retrato de busto de personagem de RPG em pixel art (estilo 16-bit, pixels grandes e nítidos, paleta limitada, contorno escuro), formato quadrado, rosto e ombros centralizados, fundo liso de uma cor só, sem texto e sem moldura. Roupa, cabelo e acessórios coerentes com o cenário e a época do mundo.\n\n${who}`,
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
    return savePortrait(c.id, m[1], Buffer.from(m[2], "base64"));
  }

  const agent = await getAgent("pixel");
  const r = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: who },
    ],
    max_tokens: agent.max_tokens,
    temperature: agent.temperature,
    reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
    agentId: "pixel",
    campaignId,
    purpose: `retrato de ${c.name}`,
  });
  await savePortrait(c.id, "image/svg+xml", Buffer.from(gridToSvg(r.content)));
}

/** Gera (ou regera, com force) o retrato do personagem em segundo plano (lib/jobs.ts). Não bloqueia. */
export async function queuePortrait(campaignId: string, characterId: string, opts: { force?: boolean } = {}): Promise<void> {
  const [c] = await q<{ name: string; has: boolean }>(
    `SELECT name, EXISTS (SELECT 1 FROM portraits WHERE character_id = $1) AS has
       FROM characters WHERE id = $1 AND campaign_id = $2`,
    [characterId, campaignId]
  );
  if (!c || (c.has && !opts.force)) return;
  const image = await imageOn();
  await startJob(
    campaignId,
    "portrait",
    characterId,
    image ? `Ilustrador pintando o retrato de ${c.name}` : `Pixel artista desenhando ${c.name}`,
    () => drawPortrait(campaignId, characterId, { image })
  );
}

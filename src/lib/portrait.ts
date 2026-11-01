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

/**
 * Em que ponto da história a campanha está (arco ativo do roteiro). Vai no prompt do Ilustrador e do reescritor para
 * cada personagem sair na fase certa da obra: sem isso, um modelo desenhava o visual de Shippuden numa sessão do Naruto clássico.
 */
export function storyMoment(campaign: Pick<Campaign, "ruleset" | "script">): string {
  const arc = campaign.script?.arcs.find((a) => a.status === "active");
  return [
    arc && `Momento da história: arco "${arc.title}": ${arc.summary.slice(0, 300)}`,
    campaign.ruleset.canonBased && "Desenhe cada personagem com a aparência e a roupa desta fase da obra, não de fases posteriores.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Uma linha por personagem em cena, com a aparência da ficha (o Ilustrador não tem outro jeito de saber como cada um é). */
export function appearanceLine(c: Pick<Character, "name" | "kind" | "canon" | "persona">): string {
  const p = c.persona;
  const who = [c.kind === "player" ? "protagonista, o \"você\" da narração" : "NPC", c.canon && "personagem da obra", p.age].filter(Boolean).join(", ");
  return `- ${c.name} (${who}): ${p.appearance || (c.canon ? "aparência oficial da obra nesta fase" : "aparência não registrada")}`;
}

/** Quem é o personagem, em texto curto e agnóstico de cenário (entra no prompt do Ilustrador). */
export function describe(campaign: Pick<Campaign, "ruleset"> & Partial<Pick<Campaign, "script">>, c: Pick<Character, "name" | "kind" | "canon" | "sheet" | "persona">): string {
  const rs = campaign.ruleset;
  const rank = rs.ranks?.find((r) => r.key === c.sheet.rank)?.label || c.sheet.rank;
  const extra = Object.entries(c.sheet.extra || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${rs.extraFields?.find((f) => f.key === k)?.label || k}: ${v}`)
    .join("; ");
  const p = c.persona;
  return [
    `Cenário: ${rs.name}${rs.description ? `. ${rs.description}` : ""}`,
    storyMoment({ ruleset: rs, script: campaign.script ?? null }),
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

// estilos padrão (o card do Ilustrador pode fixar outro, em sceneStyle / portraitStyle)
const STYLES = {
  scene: "ilustração em estilo anime cinematográfico detalhado",
  portrait: "pixel art estilo 16-bit, pixels grandes e nítidos, paleta limitada, contorno escuro",
};

const rewriteRules = (fixedStyle: boolean) =>
  `Reescreva o pedido de ilustração abaixo como um prompt para um modelo de geração de imagem, em inglês, com até 150 palavras. ${
    fixedStyle
      ? "O estilo é fixo e vai separado, antes do seu texto: não descreva estilo, só o conteúdo."
      : "Comece por uma frase de estilo completa, fiel ao estilo pedido e detalhada: traço, renderização, luz, paleta e nível de detalhe."
  } Mantenha o enquadramento e o formato; descreva só o que se vê: quem aparece e sua aparência concreta, roupa, expressão, o lugar, a luz e o clima. Mantenha os nomes da obra e dos personagens e escreva junto a aparência de cada um: a da lista de personagens quando houver; para personagem da obra sem aparência registrada, o visual oficial (roupa, cores, acessórios, idade) da fase indicada em "Momento da história", nunca de fases posteriores. Sem texto na imagem. Responda só o prompt.`;

/**
 * Prompt do Ilustrador: estilo + conteúdo (em português). O estilo fixado no card (params.sceneStyle / portraitStyle) vai
 * no começo sem passar pela reescrita, para toda imagem sair igual; vazio, vale o padrão. Com params.promptModel (modelo de
 * texto da mesma fonte) o conteúdo é reescrito curto e em inglês antes: os modelos de difusão rendem mais assim.
 * Falhou a reescrita = estilo + conteúdo originais.
 */
export async function imagePrompt(
  agent: Awaited<ReturnType<typeof getAgent>>,
  kind: keyof typeof STYLES,
  content: string,
  campaignId: string
): Promise<string> {
  const fixed = String(agent.params[`${kind}Style`] ?? "").trim();
  const original = `${fixed || STYLES[kind]}.\n\n${content}`;
  const model = String(agent.params.promptModel ?? "").trim();
  if (!model) return original;
  try {
    const r = await chat({
      model,
      messages: [{ role: "system", content: rewriteRules(!!fixed) }, { role: "user", content: fixed ? content : original }],
      // modelo que raciocina (Nemotron e afins) gastava os 2000 tokens pensando e não escrevia nada: raciocínio curto e folga
      reasoning: { effort: "low" },
      max_tokens: 4000,
      temperature: 0.3,
      agentId: "image",
      campaignId,
      purpose: "prompt da imagem (reescrita)",
    });
    const text = r.content.trim();
    return text ? (fixed ? `${fixed}. ${text}` : text) : original;
  } catch {
    return original;
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
        "portrait",
        `Retrato de busto de personagem de RPG, formato quadrado, rosto e ombros centralizados, fundo liso de uma cor só, sem texto e sem moldura. Roupa, cabelo e acessórios coerentes com o cenário e a época do mundo.\n\n${describe(campaign, c)}`,
        campaignId
      ),
    }],
    modalities: ["image", "text"],
    aspectRatio: "1:1", // retrato quadrado (o prompt também pede, mas FLUX, Recraft e afins seguem o parâmetro)
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

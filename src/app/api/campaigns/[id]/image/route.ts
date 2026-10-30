import { NextRequest, NextResponse } from "next/server";
import { getSetting, q } from "@/lib/db";
import { getAgent } from "@/lib/agents";
import { chat } from "@/lib/openrouter";
import { getCampaign, getCurrentScene } from "@/lib/engine";
import { getClock, period } from "@/lib/clock";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST → gera imagem do ambiente atual (últimas narrações + estado da cena). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // geração desligada nas Configurações: recusa aqui também, para não gerar custo nem por engano
  if ((await getSetting<{ imageGeneration?: boolean }>("ui", {})).imageGeneration === false)
    return NextResponse.json({ error: "A geração de imagens está desligada nas Configurações." }, { status: 403 });
  try {
    const [campaign, scene, agent, lastMsgs] = await Promise.all([
      getCampaign(id),
      getCurrentScene(id),
      getAgent("image"),
      q<{ content: string }>(
        `SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm'
         ORDER BY id DESC LIMIT 2`,
        [id]
      ),
    ]);
    const context = lastMsgs
      .map((m) => m.content)
      .reverse()
      .join("\n")
      .slice(-2500);
    const clock = getClock(campaign.state);
    const light = clock ? ` Período do dia: ${period(clock.minutes)} (a luz e o céu devem refletir isso).` : "";
    const prompt = `Ilustração de cena de RPG, estilo anime cinematográfico detalhado. Cenário: ${campaign.ruleset.name}. Local: ${scene.location || "desconhecido"}. Modo da cena: ${scene.mode}.${light}\n\nDescrição do momento atual (ilustre fielmente o ambiente e a atmosfera; sem texto na imagem):\n${context}`;

    const result = await chat({
      model: agent.model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      max_tokens: agent.max_tokens,
      temperature: agent.temperature,
      agentId: "image",
      campaignId: id,
      purpose: "imagem da cena",
    });
    if (!result.images.length)
      return NextResponse.json(
        { error: "O modelo não retornou imagem. Verifique o modelo do agente Ilustrador." },
        { status: 502 }
      );
    const rows = await q<{ id: number }>(
      `INSERT INTO scene_images (campaign_id, scene_id, prompt, data_url)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [id, scene.id, prompt.slice(0, 2000), result.images[0]]
    );
    return NextResponse.json({ id: rows[0].id, dataUrl: result.images[0] });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

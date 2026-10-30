import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getAgent } from "@/lib/agents";
import { chat } from "@/lib/openrouter";
import { getCampaign, getCurrentScene } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST → gera imagem do ambiente atual (últimas narrações + estado da cena). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // "gerar novamente": regenerate = true e, opcionalmente, o motivo/ajuste escrito pelo jogador
  const body = (await req.json().catch(() => ({}))) as { regenerate?: boolean; feedback?: string };
  const feedback = String(body.feedback || "").trim().slice(0, 1000);
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
    let prompt = `Ilustração de cena de RPG, estilo anime cinematográfico detalhado. Cenário: ${campaign.ruleset.name}. Local: ${scene.location || "desconhecido"}. Modo da cena: ${scene.mode}.\n\nDescrição do momento atual (ilustre fielmente o ambiente e a atmosfera; sem texto na imagem):\n${context}`;
    if (body.regenerate)
      prompt += feedback
        ? `\n\nEsta é uma nova tentativa. O jogador não gostou da imagem anterior e pediu este ajuste, que tem prioridade sobre o resto: ${feedback}`
        : `\n\nEsta é uma nova tentativa: crie uma versão diferente da anterior (outro enquadramento e composição).`;

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

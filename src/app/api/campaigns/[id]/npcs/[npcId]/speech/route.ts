import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign } from "@/lib/engine";
import { modelVoices, npcVoice, speechText, synthesize, voiceSettings } from "@/lib/tts";
import type { Character } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET → modelo de fala atual, vozes padrão e vozes aceitas (para o modal do NPC). */
export async function GET() {
  const s = await voiceSettings();
  const voices = await modelVoices(s.model).catch(() => null);
  return NextResponse.json({ ...s, voices });
}

/** POST { text } → { url } do áudio da fala na voz do NPC (gera só se não estiver no cache). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { id, npcId } = await params;
  const text = speechText(String((await req.json()).text || "")).slice(0, 2000);
  if (!text) return NextResponse.json({ error: "Nada para falar." }, { status: 400 });
  try {
    const [npc] = await q<Character>(`SELECT * FROM characters WHERE id = $1 AND campaign_id = $2`, [npcId, id]);
    if (!npc) return NextResponse.json({ error: "NPC não encontrado" }, { status: 404 });
    const v = await npcVoice(npc, await getCampaign(id));
    const key = await synthesize(text, v.model, v.voice, { campaignId: id, purpose: `fala de ${npc.name} (${v.voice || "voz padrão"})` });
    return NextResponse.json({ url: `/api/tts/${key}`, voice: v.voice, gender: v.gender });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

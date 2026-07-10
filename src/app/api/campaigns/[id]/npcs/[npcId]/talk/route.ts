import { NextRequest, NextResponse } from "next/server";
import { npcTalk } from "@/lib/npc";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST { text, sessionId? } → resposta do NPC (pode recusar a conversa). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { id, npcId } = await params;
  const body = await req.json();
  try {
    const result = await npcTalk(
      id,
      npcId,
      body.sessionId || null,
      String(body.text || "").trim()
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

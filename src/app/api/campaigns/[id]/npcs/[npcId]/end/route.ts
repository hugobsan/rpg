import { NextRequest, NextResponse } from "next/server";
import { endNpcChat } from "@/lib/npc";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST { sessionId } → Cronista salva os pontos importantes da conversa. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { id, npcId } = await params;
  const body = await req.json();
  if (!body.sessionId)
    return NextResponse.json({ error: "sessionId obrigatório" }, { status: 400 });
  try {
    return NextResponse.json(await endNpcChat(id, npcId, body.sessionId));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

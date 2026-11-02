import { NextRequest, NextResponse } from "next/server";
import { discardNpcChat, endNpcChat } from "@/lib/npc";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST { sessionId, discard: true } → apaga a conversa sem registrar nada. POST { sessionId } → relógio e Escrivão pela conversa, linha dela no chat da campanha e, em segundo plano, o Cronista com os pontos importantes. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { id, npcId } = await params;
  const body = await req.json();
  if (!body.sessionId)
    return NextResponse.json({ error: "sessionId obrigatório" }, { status: 400 });
  try {
    if (body.discard) {
      await discardNpcChat(id, npcId, body.sessionId);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(await endNpcChat(id, npcId, body.sessionId));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

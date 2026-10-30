import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** PUT: atualiza voz ({ model, voice } ou null = padrão pelo sexo), sexo e/ou atividade do NPC. GET: histórico de conversas. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { id, npcId } = await params;
  const body = await req.json();
  if (body.voice !== undefined)
    await q(
      `UPDATE characters SET voice = $1, updated_at = now() WHERE id = $2 AND campaign_id = $3`,
      [body.voice ? JSON.stringify(body.voice) : null, npcId, id]
    );
  if (body.gender !== undefined)
    await q(
      `UPDATE characters SET persona = persona || jsonb_build_object('gender', $1::text), updated_at = now()
       WHERE id = $2 AND campaign_id = $3`,
      [body.gender === "male" || body.gender === "female" ? body.gender : null, npcId, id]
    );
  if (body.active !== undefined)
    await q(
      `UPDATE characters SET active = $1, updated_at = now() WHERE id = $2 AND campaign_id = $3`,
      [!!body.active, npcId, id]
    );
  return NextResponse.json({ ok: true });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; npcId: string }> }
) {
  const { npcId } = await params;
  const sessionId = new URL(req.url).searchParams.get("session");
  if (!sessionId) return NextResponse.json([]);
  const rows = await q(
    `SELECT role, content, created_at::text FROM npc_chats
     WHERE npc_id = $1 AND session_id = $2 ORDER BY id`,
    [npcId, sessionId]
  );
  return NextResponse.json(rows);
}

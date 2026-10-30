import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign } from "@/lib/engine";
import { queueProfile } from "@/lib/characters";
import type { Character } from "@/lib/types";

export const dynamic = "force-dynamic";

/** POST → Refazer perfil: o Criador de personagens roda de novo em segundo plano, mantendo o que já é fato. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; npcId: string }> }) {
  const { id, npcId } = await params;
  const [npc] = await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND id = $2 AND kind = 'npc'`, [id, npcId]);
  if (!npc) return NextResponse.json({ error: "NPC não encontrado" }, { status: 404 });
  return NextResponse.json(await queueProfile(await getCampaign(id), npc, { redo: true }));
}

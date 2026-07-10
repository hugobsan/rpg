import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign, getCharacters, getCurrentScene } from "@/lib/engine";
import { listBooks } from "@/lib/books";

export const dynamic = "force-dynamic";

/** Estado completo da campanha para a tela de jogo. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    const [scene, characters, books, messages, milestones, images] = await Promise.all([
      getCurrentScene(id),
      getCharacters(id),
      listBooks(id),
      q(
        `SELECT id, role, speaker, content, meta, created_at::text FROM messages
         WHERE campaign_id = $1 AND role IN ('player','gm') ORDER BY id DESC LIMIT 80`,
        [id]
      ),
      q(
        `SELECT id, kind, subject, content, importance, created_at::text FROM memories
         WHERE campaign_id = $1 ORDER BY id DESC LIMIT 100`,
        [id]
      ),
      q(
        `SELECT id, scene_id, prompt, data_url, created_at::text FROM scene_images
         WHERE campaign_id = $1 ORDER BY id DESC LIMIT 1`,
        [id]
      ),
    ]);
    return NextResponse.json({
      campaign,
      scene,
      characters,
      books,
      messages: (messages as { id: number }[]).reverse(),
      memories: milestones,
      lastImage: images[0] || null,
    });
  } catch {
    return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await q(`DELETE FROM campaigns WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCampaign, getCharacters, getCurrentScene } from "@/lib/engine";
import { listBooks } from "@/lib/books";
import { messagePage } from "@/lib/messages";

export const dynamic = "force-dynamic";

/** Estado completo da campanha para a tela de jogo. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    const [scene, characters, books, page, milestones, images] = await Promise.all([
      getCurrentScene(id),
      getCharacters(id),
      listBooks(id),
      messagePage(id),
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
      messages: page.messages, // só o lote mais recente; as anteriores vêm de /messages?before=
      hasMore: page.hasMore,
      memories: milestones,
      // a ficha mostra a última imagem, a menos que o jogador a tenha tirado de lá (✕); ela segue na galeria
      lastImage:
        images[0] && Number(images[0].id) !== Number(campaign.state?.hiddenSheetImageId) ? images[0] : null,
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

/** PATCH { hideSheetImageId } → tira essa imagem da ficha (continua na galeria). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { hideSheetImageId?: number };
  const imageId = Number(body.hideSheetImageId);
  if (!Number.isInteger(imageId) || imageId < 1)
    return NextResponse.json({ error: "Imagem inválida" }, { status: 400 });
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('hiddenSheetImageId', $1::int) WHERE id = $2`, [
    imageId,
    id,
  ]);
  return NextResponse.json({ ok: true });
}

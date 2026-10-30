import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { campaignView } from "@/lib/campaignView";

export const dynamic = "force-dynamic";

/** Estado completo da campanha para a tela de jogo. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return NextResponse.json(await campaignView(id));
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

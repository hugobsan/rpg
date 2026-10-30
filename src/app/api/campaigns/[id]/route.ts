import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { campaignView } from "@/lib/campaignView";
import { THEMES } from "@/lib/theme";

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

/**
 * PATCH { hideSheetImageId } → tira essa imagem da ficha (continua na galeria).
 * PATCH { theme } → tema visual da campanha (key de THEMES); null volta ao tema do ruleset.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { hideSheetImageId?: number; theme?: string | null };
  if (body.theme !== undefined) {
    if (body.theme !== null && !THEMES.some((t) => t.key === body.theme))
      return NextResponse.json({ error: `Tema inválido (${THEMES.map((t) => t.key).join(", ")})` }, { status: 400 });
    await q(
      `UPDATE campaigns SET state = CASE WHEN $1::text IS NULL THEN state - 'theme' ELSE state || jsonb_build_object('theme', $1::text) END WHERE id = $2`,
      [body.theme, id]
    );
    return NextResponse.json({ ok: true });
  }
  const imageId = Number(body.hideSheetImageId);
  if (!Number.isInteger(imageId) || imageId < 1)
    return NextResponse.json({ error: "Imagem inválida" }, { status: 400 });
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('hiddenSheetImageId', $1::int) WHERE id = $2`, [
    imageId,
    id,
  ]);
  return NextResponse.json({ ok: true });
}

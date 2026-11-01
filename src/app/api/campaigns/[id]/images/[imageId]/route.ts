import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { imageFromDataUrl } from "@/lib/portrait";

export const dynamic = "force-dynamic";

/** GET → a imagem em binário (decodifica o data URL). Nunca muda, então o cache é longo. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  const { id, imageId } = await params;
  if (!/^\d+$/.test(imageId)) return new NextResponse("Imagem inválida", { status: 400 });
  try {
    const rows = await q<{ data_url: string }>(
      `SELECT data_url FROM scene_images WHERE id = $1 AND campaign_id = $2`,
      [imageId, id]
    );
    const img = rows[0] ? imageFromDataUrl(rows[0].data_url) : null;
    if (!img) return new NextResponse("Imagem não encontrada", { status: 404 });
    return new NextResponse(new Uint8Array(img.data), {
      headers: {
        "Content-Type": img.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'", // SVG aberto direto na aba: nada roda
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}

/** DELETE → apaga a imagem da galeria da campanha. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  const { id, imageId } = await params;
  if (!/^\d+$/.test(imageId)) return NextResponse.json({ error: "Imagem inválida" }, { status: 400 });
  const rows = await q(`DELETE FROM scene_images WHERE id = $1 AND campaign_id = $2 RETURNING id`, [imageId, id]);
  if (!rows.length) return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
